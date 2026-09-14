import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, decodeEventLog, getAddress, http, parseAbi, type Hex } from "viem";
import { config } from "../config.js";
import { CREDITS_PER_DOLLAR, INTRO_CREDITS, MAX_VOICE_SECONDS, VOICE_CREDITS_PER_MINUTE, VOICE_RESERVE_CREDITS, quoteBaseUnits, voiceChargeCredits } from "./pricing.js";

export const SOL_RECIPIENT = "FqdPiMhYdYTAnfXKY7opX5YxNLSL9UFtKE8HQq9T9VAb";
export const EVM_RECIPIENT = "0xbc28425dB5d9348EA6511e14313d9D28f2532B43";
export const USDG_CONTRACT = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export { CREDITS_PER_DOLLAR, INTRO_CREDITS, MAX_VOICE_SECONDS, VOICE_CREDITS_PER_MINUTE, VOICE_RESERVE_CREDITS } from "./pricing.js";
type Asset = "SOL" | "USDC" | "ETH" | "USDG";
type Quote = { id: string; user_id: string; chain: "solana" | "robinhood"; asset: Asset; sender: string; recipient: string; amount_base_units: string; credits: number; expires_at: Date; settled_at: Date | null };
const sql = config.database.url ? postgres(config.database.url, { max: 3, idle_timeout: 10, connect_timeout: 15, connection: { application_name: "termeow-agent-credits" } }) : null;
const evm = createPublicClient({ transport: http(config.robinhood.rpcUrl), chain: { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.robinhood.rpcUrl] } } } });
const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
function db() { if (!sql) throw new Error("Credit ledger is unavailable: DATABASE_URL is not configured"); return sql; }
export function creditError(message: string, status = 400) { return Object.assign(new Error(message), { status }); }

export async function balance(userId: string) {
  const client = db();
  await client`INSERT INTO termeow.agent_credit_accounts (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await client`INSERT INTO termeow.agent_credit_ledger (user_id, delta_credits, reason, reference)
    VALUES (${userId}, ${INTRO_CREDITS}, 'welcome', ${`welcome:${userId}`}) ON CONFLICT DO NOTHING`;
  const rows = await client`SELECT balance_credits, debt_credits FROM termeow.agent_credit_accounts WHERE user_id = ${userId}`;
  return Number(rows[0].balance_credits);
}

const priceCache = new Map<Asset, { price: number; at: number }>();
async function assetUsd(asset: Asset) {
  const cached = priceCache.get(asset);
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  const id = { SOL: "solana", ETH: "ethereum", USDC: "usd-coin", USDG: "global-dollar" }[asset];
  const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw creditError("Payment asset pricing is temporarily unavailable.", 503);
  const price = Number((await response.json() as Record<string, { usd?: number }>)[id]?.usd);
  if (!Number.isFinite(price) || price <= 0) throw creditError("Payment asset pricing is temporarily unavailable.", 503);
  if ((asset === "USDC" || asset === "USDG") && price < 0.98) throw creditError(`${asset} is below the accepted peg threshold. Choose another asset.`, 503);
  priceCache.set(asset, { price, at: Date.now() });
  return price;
}

export async function createQuote(userId: string, asset: Asset, usd: number, sender: string) {
  const client = db(); await balance(userId);
  if (!Number.isInteger(usd) || usd < 5 || usd > 500) throw creditError("Choose a top-up from $5 to $500.");
  const chain = asset === "SOL" || asset === "USDC" ? "solana" : "robinhood";
  try { if (chain === "solana") new PublicKey(sender); else getAddress(sender); }
  catch { throw creditError("Invalid connected wallet address."); }
  if (sender === SOL_RECIPIENT || sender.toLowerCase() === EVM_RECIPIENT.toLowerCase()) throw creditError("Use a customer wallet for top-ups.");
  const price = await assetUsd(asset);
  const decimals = asset === "SOL" ? 9 : asset === "ETH" ? 18 : 6;
  const amount = quoteBaseUnits(usd, price, decimals);
  const id = randomUUID(); const recipient = chain === "solana" ? SOL_RECIPIENT : EVM_RECIPIENT;
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  await client`INSERT INTO termeow.agent_credit_quotes (id, user_id, chain, asset, sender, recipient, amount_base_units, credits, expires_at)
    VALUES (${id}, ${userId}, ${chain}, ${asset}, ${sender}, ${recipient}, ${amount.toString()}, ${usd * CREDITS_PER_DOLLAR}, ${expiresAt})`;
  return { id, chain, asset, sender, recipient, amountBaseUnits: amount.toString(), credits: usd * CREDITS_PER_DOLLAR, expiresAt: expiresAt.toISOString(), usd };
}

async function verifiedSolana(quote: Quote, hash: string) {
  const connection = new Connection(config.rpc.primary, "finalized");
  const tx = await connection.getParsedTransaction(hash, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err || tx.blockTime == null || tx.blockTime * 1000 < new Date(quote.expires_at).getTime() - 5 * 60_000 || tx.blockTime * 1000 > new Date(quote.expires_at).getTime()) return false;
  if (!tx.transaction.message.accountKeys.some(key => key.signer && key.pubkey.toBase58() === quote.sender)) return false;
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions || []).flatMap((item) => item.instructions)];
  return instructions.some((instruction) => {
    if (!("parsed" in instruction) || !instruction.parsed || typeof instruction.parsed !== "object") return false;
    const parsed = instruction.parsed as { type?: string; info?: Record<string, string> }; const info = parsed.info || {};
    if (quote.asset === "SOL") {
      const recipientIndex = tx.transaction.message.accountKeys.findIndex(key => key.pubkey.toBase58() === quote.recipient);
      if (recipientIndex < 0 || !tx.meta) return false;
      const netReceived = BigInt(tx.meta.postBalances[recipientIndex]) - BigInt(tx.meta.preBalances[recipientIndex]);
      return instruction.program === "system" && parsed.type === "transfer" && info.source === quote.sender && info.destination === quote.recipient && BigInt(info.lamports || 0) >= BigInt(quote.amount_base_units) && netReceived >= BigInt(quote.amount_base_units);
    }
    if (instruction.program !== "spl-token" || !["transfer", "transferChecked"].includes(parsed.type || "")) return false;
    const recipientAta = PublicKey.findProgramAddressSync([new PublicKey(quote.recipient).toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(USDC_MINT).toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0].toBase58();
    const sourceBalance = tx.meta?.preTokenBalances?.find((item) => item.accountIndex === tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === info.source));
    const amount = info.amount || (info.tokenAmount as unknown as { amount?: string } | undefined)?.amount;
    const recipientIndex = tx.transaction.message.accountKeys.findIndex(key => key.pubkey.toBase58() === recipientAta);
    const pre = tx.meta?.preTokenBalances?.find(item => item.accountIndex === recipientIndex);
    const post = tx.meta?.postTokenBalances?.find(item => item.accountIndex === recipientIndex);
    const netReceived = BigInt(post?.uiTokenAmount.amount || 0) - BigInt(pre?.uiTokenAmount.amount || 0);
    return info.destination === recipientAta && info.authority === quote.sender && sourceBalance?.mint === USDC_MINT && sourceBalance.owner === quote.sender && post?.mint === USDC_MINT && post.owner === quote.recipient && BigInt(amount || 0) >= BigInt(quote.amount_base_units) && netReceived >= BigInt(quote.amount_base_units);
  });
}

async function verifiedEvm(quote: Quote, hash: Hex) {
  if (await evm.getChainId() !== 4663) throw creditError("Robinhood RPC returned the wrong chain.", 503);
  const receipt = await evm.getTransactionReceipt({ hash });
  if (receipt.status !== "success" || receipt.blockNumber + 2n > await evm.getBlockNumber()) return false;
  const block = await evm.getBlock({ blockNumber: receipt.blockNumber });
  const time = Number(block.timestamp) * 1000, expiry = new Date(quote.expires_at).getTime();
  if (time > expiry || time < expiry - 5 * 60_000) return false;
  const tx = await evm.getTransaction({ hash });
  if (tx.from.toLowerCase() !== quote.sender.toLowerCase()) return false;
  if (quote.asset === "ETH") return tx.to?.toLowerCase() === quote.recipient.toLowerCase() && tx.value >= BigInt(quote.amount_base_units);
  if (tx.to?.toLowerCase() !== USDG_CONTRACT.toLowerCase()) return false;
  return receipt.logs.some((log) => { try { const event = decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics });
    return log.address.toLowerCase() === USDG_CONTRACT.toLowerCase() && event.eventName === "Transfer" && event.args.from.toLowerCase() === quote.sender.toLowerCase() && event.args.to.toLowerCase() === quote.recipient.toLowerCase() && event.args.value >= BigInt(quote.amount_base_units);
  } catch { return false; } });
}

export async function settleQuote(userId: string, id: string, hash: string) {
  const client = db();
  const rows = await client`SELECT * FROM termeow.agent_credit_quotes WHERE id = ${id} AND user_id = ${userId}`;
  const quote = rows[0] as Quote | undefined;
  if (!quote) throw creditError("Top-up quote not found.", 404);
  if (quote.settled_at) return { balance: await balance(userId), credited: quote.credits };
  if (quote.chain === "solana" ? !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(hash) : !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw creditError("Invalid transaction hash.");
  if (quote.chain === "robinhood") hash = hash.toLowerCase();
  const verified = quote.chain === "solana" ? await verifiedSolana(quote, hash) : await verifiedEvm(quote, hash as Hex);
  if (!verified) throw creditError("Payment is not finalized or does not match this quote. Retry shortly.", 409);
  await client.begin(async (tx) => {
    const updated = await tx`UPDATE termeow.agent_credit_quotes SET tx_hash = ${hash}, settled_at = now()
      WHERE id = ${id} AND user_id = ${userId} AND settled_at IS NULL RETURNING credits`;
    if (!updated.length) return;
    await tx`UPDATE termeow.agent_credit_accounts SET balance_credits = balance_credits + GREATEST(0, ${quote.credits} - debt_credits),
      debt_credits = GREATEST(0, debt_credits - ${quote.credits}), updated_at = now() WHERE user_id = ${userId}`;
    await tx`INSERT INTO termeow.agent_credit_ledger (user_id, delta_credits, reason, reference) VALUES (${userId}, ${quote.credits}, 'topup', ${`payment:${quote.chain}:${hash}`})`;
  });
  return { balance: await balance(userId), credited: quote.credits };
}

export async function reserveVoice(userId: string, conversationId: string, tokenExpiresAt: Date) {
  const client = db(); await balance(userId);
  return client.begin(async (tx) => {
    const rows = await tx`UPDATE termeow.agent_credit_accounts SET balance_credits = balance_credits - ${VOICE_RESERVE_CREDITS}, updated_at = now()
      WHERE user_id = ${userId} AND balance_credits >= ${VOICE_RESERVE_CREDITS} AND debt_credits = 0 RETURNING balance_credits`;
    if (!rows.length) throw creditError(`A voice call requires a refundable ${VOICE_RESERVE_CREDITS}-credit hold. Top up to continue.`, 402);
    await tx`INSERT INTO termeow.agent_voice_sessions (conversation_id, user_id, reserved_credits, token_expires_at) VALUES (${conversationId}, ${userId}, ${VOICE_RESERVE_CREDITS}, ${tokenExpiresAt})`;
    await tx`INSERT INTO termeow.agent_credit_ledger (user_id, delta_credits, reason, reference) VALUES (${userId}, ${-VOICE_RESERVE_CREDITS}, 'voice_hold', ${`voice:hold:${conversationId}`})`;
    return Number(rows[0].balance_credits);
  });
}

export async function hasVoiceReservation(userId: string) {
  const rows = await db()`SELECT 1 FROM termeow.agent_voice_sessions WHERE user_id = ${userId} AND settled_at IS NULL
    AND created_at > now() - interval '15 minutes' LIMIT 1`;
  return rows.length > 0;
}

export async function reconcileVoice(conversationId: string, onlyUserId?: string) {
  const client = db();
  const rows = await client`SELECT * FROM termeow.agent_voice_sessions WHERE conversation_id = ${conversationId}`;
  const session = rows[0] as { user_id: string; reserved_credits: number; settled_at: Date | null; created_at: Date; token_expires_at: Date; not_found_count: number } | undefined;
  if (!session || (onlyUserId && session.user_id !== onlyUserId)) throw creditError("Voice session not found.", 404);
  if (session.settled_at) return { balance: await balance(session.user_id), settled: true };
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
    headers: { "xi-api-key": config.elevenlabs.apiKey || "", Accept: "application/json" }, signal: AbortSignal.timeout(8000)
  });
  if (response.status === 404) {
    const misses = await client`UPDATE termeow.agent_voice_sessions SET not_found_count = not_found_count + 1
      WHERE conversation_id = ${conversationId} AND settled_at IS NULL RETURNING not_found_count`;
    if (Number(misses[0]?.not_found_count || 0) >= 3 && Date.now() > new Date(session.token_expires_at).getTime() + (MAX_VOICE_SECONDS + 60) * 1000) {
      await client.begin(async (tx) => {
        const unused = await tx`UPDATE termeow.agent_voice_sessions SET charged_credits = 0, provider_cost_usd = 0,
          duration_seconds = 0, settled_at = now() WHERE conversation_id = ${conversationId} AND settled_at IS NULL RETURNING user_id`;
        if (!unused.length) return;
        await tx`UPDATE termeow.agent_credit_accounts SET balance_credits = balance_credits + ${Number(session.reserved_credits)}, updated_at = now() WHERE user_id = ${session.user_id}`;
        await tx`INSERT INTO termeow.agent_credit_ledger (user_id, delta_credits, reason, reference)
          VALUES (${session.user_id}, ${Number(session.reserved_credits)}, 'unused_voice_hold', ${`voice:settle:${conversationId}`})`;
      });
      return { balance: await balance(session.user_id), settled: true, charged: 0 };
    }
  }
  if (!response.ok) return { balance: await balance(session.user_id), settled: false };
  const details = await response.json() as { status?: string; metadata?: { cost_fiat?: number; call_duration_secs?: number } };
  if (!details.status || !["done", "failed"].includes(details.status)) return { balance: await balance(session.user_id), settled: false };
  const cost = Number(details.metadata?.cost_fiat), duration = Number(details.metadata?.call_duration_secs);
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(duration) || duration < 0) return { balance: await balance(session.user_id), settled: false };
  // Higher of the posted 40 credits/minute or 2x provider cost, preserving >=50% gross margin.
  const charged = details.status === "failed" && duration === 0 ? 0 : voiceChargeCredits(duration, cost);
  const held = Number(session.reserved_credits), refund = Math.max(0, held - charged), debt = Math.max(0, charged - held);
  await client.begin(async (tx) => {
    const updated = await tx`UPDATE termeow.agent_voice_sessions SET charged_credits = ${charged}, provider_cost_usd = ${cost},
      duration_seconds = ${Math.ceil(duration)}, settled_at = now() WHERE conversation_id = ${conversationId} AND settled_at IS NULL RETURNING user_id`;
    if (!updated.length) return;
    await tx`UPDATE termeow.agent_credit_accounts SET balance_credits = balance_credits + ${refund}, debt_credits = debt_credits + ${debt}, updated_at = now() WHERE user_id = ${session.user_id}`;
    await tx`INSERT INTO termeow.agent_credit_ledger (user_id, delta_credits, reason, reference)
      VALUES (${session.user_id}, ${refund - debt}, 'voice_settlement', ${`voice:settle:${conversationId}`})`;
  });
  return { balance: await balance(session.user_id), settled: true, charged };
}

export async function reconcilePendingVoice() {
  if (!sql || !config.elevenlabs.apiKey) return;
  const rows = await sql`SELECT conversation_id FROM termeow.agent_voice_sessions
    WHERE settled_at IS NULL AND created_at < now() - interval '45 seconds' ORDER BY created_at LIMIT 20`;
  await Promise.allSettled(rows.map((row) => reconcileVoice(String(row.conversation_id))));
}
