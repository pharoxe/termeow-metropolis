import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config.js";
import { clawpumpMcp } from "../clawpump/mcp.js";
import { getBoard, getHolders, getOnchainMarket, getTrenches, trenchSorts } from "../clawpump/market.js";
import { errorMessage, fetchJson } from "../lib/http.js";

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const chainAddress = z.union([address, evmAddress]);
export const quoteSchema = z.object({
  chain: z.enum(["solana", "robinhood"]).default("solana"),
  router: z.enum(["0x", "jupiter", "clawpump"]).default("jupiter"),
  inputMint: chainAddress,
  outputMint: chainAddress,
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(1).max(500).default(50),
  walletAddress: chainAddress.optional()
}).superRefine((input, ctx) => {
  const validator = input.chain === "solana" ? address : evmAddress;
  for (const [field, value] of [["inputMint", input.inputMint], ["outputMint", input.outputMint], ["walletAddress", input.walletAddress]] as const) {
    if (value && !validator.safeParse(value).success) ctx.addIssue({ code: "custom", path: [field], message: `${field} is not valid for ${input.chain}` });
  }
  if (input.chain === "robinhood" && input.router !== "0x") ctx.addIssue({ code: "custom", path: ["router"], message: "Robinhood Chain currently routes through 0x." });
  if (input.chain === "solana" && input.router === "jupiter" && input.inputMint.startsWith("0x")) ctx.addIssue({ code: "custom", path: ["inputMint"], message: "Jupiter requires Solana mint addresses." });
});

export const onchainRouter = Router();
type RouterId = "0x" | "jupiter" | "clawpump";
type ChainId = "solana" | "robinhood";
type QuoteInput = z.infer<typeof quoteSchema>;
const quoteCache = new Map<string, { expiresAt: number; router: RouterId; chain: ChainId; walletAddress?: string; request: QuoteInput; quote: unknown }>();

type ZeroExInstruction = {
  accounts: Array<{ pubkey: number[]; is_signer: boolean; is_writable: boolean }>;
  data: number[];
  program_id: number[];
};
type ZeroExSolanaQuote = {
  address_lookup_tables?: string[];
  amount_out: number | string;
  min_amount_out: number | string;
  instructions: ZeroExInstruction[];
  route_plan?: Array<{ dex_label?: string }>;
  zid?: string;
};

type ZeroExEvmQuote = {
  allowanceTarget?: string;
  buyAmount: string;
  minBuyAmount?: string;
  price?: string;
  estimatedPriceImpact?: string;
  issues?: { allowance?: { actual?: string; spender?: string } | null };
  route?: { fills?: Array<{ source?: string; proportionBps?: string }> };
  transaction: {
    to: string;
    data: string;
    value?: string;
    gas?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
};

const ROBINHOOD_CHAIN_ID = 4663;

async function zeroExSolanaTransaction(quote: ZeroExSolanaQuote, taker: string) {
  const connection = new Connection(config.rpc.primary, "confirmed");
  const instructions = quote.instructions.map((instruction) => new TransactionInstruction({
    programId: new PublicKey(Uint8Array.from(instruction.program_id)),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(Uint8Array.from(account.pubkey)),
      isSigner: account.is_signer,
      isWritable: account.is_writable
    })),
    data: Buffer.from(instruction.data)
  }));
  const lookupKeys = quote.address_lookup_tables ?? [];
  const [lookupInfos, latestBlockhash] = await Promise.all([
    lookupKeys.length ? connection.getMultipleAccountsInfo(lookupKeys.map((key) => new PublicKey(key))) : Promise.resolve([]),
    connection.getLatestBlockhash("confirmed")
  ]);
  const lookups = lookupInfos.map((info, index) => {
    if (!info) throw new Error(`0x address lookup table was unavailable: ${lookupKeys[index]}`);
    return new AddressLookupTableAccount({
      key: new PublicKey(lookupKeys[index]),
      state: AddressLookupTableAccount.deserialize(info.data)
    });
  });
  const message = new TransactionMessage({
    payerKey: new PublicKey(taker),
    recentBlockhash: latestBlockhash.blockhash,
    instructions
  }).compileToV0Message(lookups);
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

export function sameQuoteRequest(left: QuoteInput, right: QuoteInput) {
  return left.chain === right.chain && left.router === right.router && left.inputMint.toLowerCase() === right.inputMint.toLowerCase()
    && left.outputMint.toLowerCase() === right.outputMint.toLowerCase() && left.amount === right.amount
    && left.slippageBps === right.slippageBps && left.walletAddress?.toLowerCase() === right.walletAddress?.toLowerCase();
}

function cacheQuote(input: QuoteInput, quote: unknown) {
  const now = Date.now();
  for (const [id, cached] of quoteCache) if (cached.expiresAt < now) quoteCache.delete(id);
  const quoteId = randomUUID();
  quoteCache.set(quoteId, { expiresAt: now + 60_000, router: input.router, chain: input.chain, walletAddress: input.walletAddress, request: input, quote });
  return quoteId;
}

function findJupiterQuote(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.routePlan) && typeof record.inputMint === "string" && typeof record.outputMint === "string") return record;
  for (const child of Object.values(record)) {
    const found = findJupiterQuote(child);
    if (found) return found;
  }
  return undefined;
}

onchainRouter.get("/search", async (request, response, next) => {
  try {
    const query = z.string().min(1).max(80).parse(request.query.q);
    const result = await clawpumpMcp.call("token_search", { query });
    response.status(result.ok ? 200 : 502).json(result);
  } catch (error) { next(error); }
});


onchainRouter.get("/board", async (_request, response) => {
  try {
    const board = await getBoard();
    response.json({ observedAt: Date.now(), source: "clawpump-board", ttlMs: 30_000, ...board });
  } catch (error) {
    response.json({ observedAt: Date.now(), source: "clawpump-board", ttlMs: 30_000, error: errorMessage(error) });
  }
});

onchainRouter.get("/trenches", async (request, response) => {
  try {
    const sort = trenchSorts.includes(String(request.query.sort) as typeof trenchSorts[number])
      ? String(request.query.sort) as typeof trenchSorts[number]
      : "hot";
    response.json(await getTrenches(sort));
  } catch (error) {
    response.json({ sort: String(request.query.sort || "hot"), tokens: [], error: errorMessage(error) });
  }
});

onchainRouter.get("/holders/:mint", async (request, response, next) => {
  try {
    const mint = address.parse(request.params.mint);
    response.json(await getHolders(mint));
  } catch (error) { next(error); }
});

onchainRouter.get("/market/:mint", async (request, response, next) => {
  try {
    const mint = address.parse(request.params.mint);
    const interval = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("5m").parse(request.query.interval);
    response.json(await getOnchainMarket(mint, interval));
  } catch (error) { next(error); }
});

onchainRouter.post("/quote", async (request, response, next) => {
  try {
    const input = quoteSchema.parse(request.body);
    if (input.router === "0x") {
      if (!config.zeroEx.apiKey) {
        response.status(503).json({ error: "0x routing is not configured", hint: "Set ZEROEX_API_KEY on the server." });
        return;
      }
      if (!input.walletAddress) {
        response.status(400).json({ error: `Connect the ${input.chain === "solana" ? "Solana" : "Robinhood"} wallet before requesting a firm 0x quote.` });
        return;
      }
      if (input.chain === "robinhood") {
        const params = new URLSearchParams({
          chainId: String(ROBINHOOD_CHAIN_ID),
          sellToken: input.inputMint,
          buyToken: input.outputMint,
          sellAmount: input.amount,
          taker: input.walletAddress,
          slippageBps: String(input.slippageBps)
        });
        const result = await fetchJson<ZeroExEvmQuote>(`${config.zeroEx.apiUrl}/swap/allowance-holder/quote?${params}`, {
          headers: { "0x-api-key": config.zeroEx.apiKey, "0x-version": "v2" }
        });
        const quoteId = cacheQuote(input, result);
        response.json({
          quoteId,
          chain: input.chain,
          router: "0x",
          source: "0x AllowanceHolder · Robinhood Chain",
          observedAt: Date.now(),
          outAmount: result.buyAmount,
          minimumOutAmount: result.minBuyAmount,
          price: result.price,
          priceImpactPct: result.estimatedPriceImpact,
          allowanceRequired: Boolean(result.issues?.allowance),
          routePlan: result.route?.fills ?? []
        });
        return;
      }
      const amountIn = Number(input.amount);
      if (!Number.isSafeInteger(amountIn)) {
        response.status(400).json({ error: "The atomic input amount is outside the supported range." });
        return;
      }
      const result = await fetchJson<ZeroExSolanaQuote>(`${config.zeroEx.apiUrl}/solana/swap-instructions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "0x-api-key": config.zeroEx.apiKey },
        body: JSON.stringify({
          token_in: input.inputMint,
          token_out: input.outputMint,
          amount_in: amountIn,
          taker: input.walletAddress,
          slippage_bps: input.slippageBps
        })
      });
      const quoteId = cacheQuote(input, result);
      response.json({
        quoteId,
        router: "0x",
        source: "0x Solana Swap API",
        observedAt: Date.now(),
        outAmount: String(result.amount_out),
        minimumOutAmount: String(result.min_amount_out),
        routePlan: result.route_plan ?? [],
        zid: result.zid
      });
      return;
    }
    if (input.router === "jupiter") {
      const params = new URLSearchParams({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        amount: input.amount,
        slippageBps: String(input.slippageBps),
        swapMode: "ExactIn",
        restrictIntermediateTokens: "true"
      });
      const result = await fetchJson<Record<string, unknown>>(`${config.jupiter.apiUrl}/quote?${params}`, {
        headers: config.jupiter.apiKey ? { "x-api-key": config.jupiter.apiKey } : undefined
      });
      const quoteId = cacheQuote(input, result);
      response.json({ quoteId, chain: input.chain, router: "jupiter", source: "Jupiter Swap API", observedAt: Date.now(), ...result });
      return;
    }
    const result = await clawpumpMcp.call("swap_quote", {
      ...(config.clawpump.agentId ? { agent_id: config.clawpump.agentId } : {}),
      input_mint: input.inputMint,
      output_mint: input.outputMint,
      amount: input.amount,
      slippage_bps: input.slippageBps
    });
    if (!result.ok) {
      response.status(502).json({ error: "ClawPump quote failed", detail: result.error });
      return;
    }
    const quoteId = cacheQuote(input, result.data);
    response.json({ quoteId, router: "clawpump", source: "ClawPump + Jupiter", observedAt: Date.now(), ...result });
  } catch (error) { next(error); }
});

onchainRouter.post("/transaction", async (request, response, next) => {
  try {
    const quoteId = z.string().uuid().parse(request.body?.quoteId);
    const input = quoteSchema.parse(request.body);
    const cached = quoteCache.get(quoteId);
    if (!cached || cached.expiresAt < Date.now()) {
      response.status(409).json({ error: "Quote expired", hint: "Request a fresh router quote before building the transaction." });
      return;
    }
    if (!input.walletAddress) {
      response.status(400).json({ error: "A connected wallet is required to build the transaction." });
      return;
    }
    if (!sameQuoteRequest(cached.request, input)) {
      response.status(409).json({ error: "The transaction request no longer matches the quoted route." });
      return;
    }
    quoteCache.delete(quoteId);
    if (cached.router === "0x") {
      if (cached.chain === "robinhood") {
        const quote = cached.quote as ZeroExEvmQuote;
        const allowance = quote.issues?.allowance;
        response.json({
          source: "0x AllowanceHolder · Robinhood Chain",
          router: "0x",
          chain: "robinhood",
          signingMode: "user-wallet",
          transaction: { ...quote.transaction, chainId: ROBINHOOD_CHAIN_ID },
          approval: allowance ? {
            required: true,
            token: input.inputMint,
            spender: allowance.spender || quote.allowanceTarget,
            amount: input.amount,
            currentAllowance: allowance.actual
          } : { required: false }
        });
        return;
      }
      const transaction = await zeroExSolanaTransaction(cached.quote as ZeroExSolanaQuote, input.walletAddress);
      response.json({ source: "0x Solana Swap API", router: "0x", chain: "solana", signingMode: "user-wallet", transaction });
      return;
    }
    const quoteResponse = cached.router === "jupiter" ? cached.quote as Record<string, unknown> : findJupiterQuote(cached.quote);
    if (!quoteResponse) {
      response.status(502).json({ error: "ClawPump quote did not contain a Jupiter-compatible route" });
      return;
    }
    const result = await fetchJson<Record<string, unknown>>(`${config.jupiter.apiUrl}/swap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.jupiter.apiKey ? { "x-api-key": config.jupiter.apiKey } : {})
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: input.walletAddress,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto"
      })
    });
    response.json({ source: cached.router === "jupiter" ? "Jupiter Swap API" : "clawpump+jupiter", router: cached.router, chain: "solana", signingMode: "user-wallet", ...result });
  } catch (error) { next(error); }
});

onchainRouter.get("/portfolio/:wallet", async (request, response, next) => {
  try {
    const walletAddress = address.parse(request.params.wallet);
    const args = { walletAddress, ...(config.clawpump.agentId ? { agentId: config.clawpump.agentId } : {}) };
    const result = await clawpumpMcp.call("get_portfolio", args);
    response.status(result.ok ? 200 : 502).json(result);
  } catch (error) { next(error); }
});
