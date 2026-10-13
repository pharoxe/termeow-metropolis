import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createPublicClient, decodeEventLog, defineChain, getAddress, http, parseAbi, type Hex } from "viem";
import { config } from "../config.js";
import { CREDITS_PER_DOLLAR, INTRO_CREDITS, MAX_VOICE_SECONDS, VOICE_CREDITS_PER_MINUTE, VOICE_RESERVE_CREDITS, quoteBaseUnits, voiceChargeCredits } from "./pricing.js";
import { dexScreenerTokensUrl, parseDexScreenerTokenPrices } from "../tape/monad/price.js";

/** Treasury that receives credit top-ups on Monad. */
export const EVM_RECIPIENT = "0xbc28425dB5d9348EA6511e14313d9D28f2532B43";
export { CREDITS_PER_DOLLAR, INTRO_CREDITS, MAX_VOICE_SECONDS, VOICE_CREDITS_PER_MINUTE, VOICE_RESERVE_CREDITS } from "./pricing.js";
export type Asset = "MON" | "USDC" | "AUSD";
/** ERC-20 contracts accepted for top-ups (6 decimals each); MON is native. */
export const TOKEN_CONTRACTS: Record<Exclude<Asset, "MON">, string> = {
  USDC: config.network.tokens.usdc,
  AUSD: config.network.tokens.ausd ?? config.network.tokens.usdc
};
export const ASSET_DECIMALS: Record<Asset, number> = { MON: 18, USDC: 6, AUSD: 6 };
type Quote = { id: string; user_id: string; chain: "monad"; asset: Asset; sender: string; recipient: string; amount_base_units: string; credits: number; expires_at: Date; settled_at: Date | null };
const sql = config.database.url ? postgres(config.database.url, { max: 3, idle_timeout: 10, connect_timeout: 15, connection: { application_name: "termeow-agent-credits" } }) : null;
const monadChain = defineChain({
  id: config.network.chainId,
  name: config.network.name,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [config.monad.rpcUrl] } }
});
const evm = createPublicClient({ transport: http(config.monad.rpcUrl), chain: monadChain });
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
type PriceFetch = typeof fetch;
const COINGECKO_IDS: Record<Asset, string> = { MON: "monad", USDC: "usd-coin", AUSD: "agora-dollar" };

async function coingeckoAssetUsd(asset: Asset, fetchImpl: PriceFetch) {
  const id = COINGECKO_IDS[asset];
  const response = await fetchImpl(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, { signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error(`CoinGecko returned ${response.status}`);
  const price = Number((await response.json() as Record<string, { usd?: number }>)[id]?.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error("CoinGecko returned no usable price");
  return price;
}

/** MON from the deepest DexScreener WMON pair on Monad, independent of CoinGecko. */
async function dexScreenerMonUsd(fetchImpl: PriceFetch) {
  const wmon = config.network.tokens.wmon;
  const response = await fetchImpl(dexScreenerTokensUrl("monad", [wmon]), { signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error(`DexScreener returned ${response.status}`);
  const price = parseDexScreenerTokenPrices(await response.json(), new Set([wmon]), "monad").get(wmon);
  if (!price) throw new Error("DexScreener returned no usable MON price");
  return price;
}

/** Independent providers for MON so transfer quotes do not depend on CoinGecko availability. */
export async function fetchAssetUsd(asset: Asset, fetchImpl: PriceFetch = fetch) {
  const providers = asset === "MON"
    ? [coingeckoAssetUsd(asset, fetchImpl), dexScreenerMonUsd(fetchImpl)]
    : [coingeckoAssetUsd(asset, fetchImpl)];
  try {
    return await Promise.any(providers);
  } catch {
    throw creditError("Payment asset pricing is temporarily unavailable.", 503);
  }
}

export async function assetUsd(asset: Asset) {
  const cached = priceCache.get(asset);
  if (cached && Date.now() - cached.at < 60_000) return cached.price;
  let price: number;
  try {
    price = await fetchAssetUsd(asset);
  } catch (error) {
    // A recent quote is safer than making a two-message transfer flow fail on a brief provider outage.
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.price;
    throw error;
  }
  if ((asset === "USDC" || asset === "AUSD") && price < 0.98) throw creditError(`${asset} is below the accepted peg threshold. Choose another asset.`, 503);
  priceCache.set(asset, { price, at: Date.now() });
  return price;
}

export async function createQuote(userId: string, asset: Asset, usd: number, sender: string) {
  const client = db(); await balance(userId);
  if (!Number.isInteger(usd) || usd < 5 || usd > 500) throw creditError("Choose a top-up from $5 to $500.");
  try { getAddress(sender); }
  catch { throw creditError("Invalid connected wallet address."); }
  if (sender.toLowerCase() === EVM_RECIPIENT.toLowerCase()) throw creditError("Use a customer wallet for top-ups.");
  const price = await assetUsd(asset);
  const amount = quoteBaseUnits(usd, price, ASSET_DECIMALS[asset]);
  const id = randomUUID(); const recipient = EVM_RECIPIENT; const chain = "monad" as const;
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  await client`INSERT INTO termeow.agent_credit_quotes (id, user_id, chain, asset, sender, recipient, amount_base_units, credits, expires_at)
    VALUES (${id}, ${userId}, ${chain}, ${asset}, ${sender}, ${recipient}, ${amount.toString()}, ${usd * CREDITS_PER_DOLLAR}, ${expiresAt})`;
  return { id, chain, asset, sender, recipient, contract: asset === "MON" ? null : TOKEN_CONTRACTS[asset], decimals: ASSET_DECIMALS[asset], amountBaseUnits: amount.toString(), credits: usd * CREDITS_PER_DOLLAR, expiresAt: expiresAt.toISOString(), usd };
}

/** Monad finalizes in two slots; the receipt must be at or below the `finalized` head before credits are granted. */
async function verifiedEvm(quote: Quote, hash: Hex) {
  if (await evm.getChainId() !== config.network.chainId) throw creditError("Monad RPC returned the wrong chain.", 503);
  const receipt = await evm.getTransactionReceipt({ hash });
  const finalized = await evm.getBlock({ blockTag: "finalized" });
  if (receipt.status !== "success" || receipt.blockNumber > finalized.number) return false;
  const block = await evm.getBlock({ blockNumber: receipt.blockNumber });
  const time = Number(block.timestamp) * 1000, expiry = new Date(quote.expires_at).getTime();
  if (time > expiry || time < expiry - 5 * 60_000) return false;
  const tx = await evm.getTransaction({ hash });
  if (tx.from.toLowerCase() !== quote.sender.toLowerCase()) return false;
  if (quote.asset === "MON") return tx.to?.toLowerCase() === quote.recipient.toLowerCase() && tx.value >= BigInt(quote.amount_base_units);
  const contract = TOKEN_CONTRACTS[quote.asset].toLowerCase();
  if (tx.to?.toLowerCase() !== contract) return false;
  return receipt.logs.some((log) => { try { const event = decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics });
    return log.address.toLowerCase() === contract && event.eventName === "Transfer" && event.args.from.toLowerCase() === quote.sender.toLowerCase() && event.args.to.toLowerCase() === quote.recipient.toLowerCase() && event.args.value >= BigInt(quote.amount_base_units);
  } catch { return false; } });
}

export async function settleQuote(userId: string, id: string, hash: string) {
  const client = db();
  const rows = await client`SELECT * FROM termeow.agent_credit_quotes WHERE id = ${id} AND user_id = ${userId}`;
  const quote = rows[0] as Quote | undefined;
  if (!quote) throw creditError("Top-up quote not found.", 404);
  if (quote.settled_at) return { balance: await balance(userId), credited: quote.credits };
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw creditError("Invalid transaction hash.");
  hash = hash.toLowerCase();
  const verified = await verifiedEvm(quote, hash as Hex);
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
