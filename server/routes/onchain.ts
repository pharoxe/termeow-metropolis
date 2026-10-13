import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { NATIVE_SENTINEL, isNativeMon } from "../../shared/chains.js";
import { config } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { monadWalletPortfolio } from "../market/monadWalletPortfolio.js";
import { runResearchTool } from "../agent/monadTools.js";
import { getNansen } from "../sources/nansen.js";
import { getPerpl } from "../sources/perpl.js";
import { KuruFlowClient, type KuruQuote } from "../trading/kuru.js";
import { QuoteCache, matchesOrder } from "../trading/quotes.js";

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const quoteSchema = z.object({
  chain: z.literal("monad").default("monad"),
  router: z.enum(["kuru", "0x"]).default("kuru"),
  inputMint: evmAddress,
  outputMint: evmAddress,
  amount: z.string().regex(/^[1-9]\d{0,77}$/),
  slippageBps: z.number().int().min(1).max(500).default(50),
  walletAddress: evmAddress.optional()
}).superRefine((input, ctx) => {
  if (input.inputMint.toLowerCase() === input.outputMint.toLowerCase()) ctx.addIssue({ code: "custom", path: ["outputMint"], message: "Input and output tokens must differ" });
});

export const onchainRouter = Router();
type QuoteInput = z.infer<typeof quoteSchema>;
// One bounded, pruned cache for both routers: an unbounded Map keyed on quote id never releases a quote that was
// requested and then abandoned, which is the common case.
const quoteCache = new QuoteCache();
const quoteCleanup = setInterval(() => quoteCache.prune(), 30_000);
quoteCleanup.unref();
const kuru = new KuruFlowClient({ apiUrl: config.kuru.apiUrl });

type ZeroExEvmQuote = {
  allowanceTarget?: string;
  buyAmount: string;
  minBuyAmount?: string;
  price?: string;
  estimatedPriceImpact?: string;
  issues?: { allowance?: { actual?: string; spender?: string } | null };
  route?: { fills?: Array<{ source?: string; proportionBps?: string }> };
  transaction: { to: string; data: string; value?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
};

/** 0x names native MON with the 0xEeee… sentinel; Kuru with the zero address (normalised inside the Kuru client). */
function zeroExToken(address: string): string {
  return isNativeMon(address) ? NATIVE_SENTINEL : address;
}

export function sameQuoteRequest(left: QuoteInput, right: QuoteInput) {
  return matchesOrder(left, right);
}

function cacheQuote(input: QuoteInput, quote: unknown) {
  const quoteId = randomUUID();
  const expiresAt = quoteCache.set(quoteId, quote, input, input.router);
  return { quoteId, expiresAt };
}

/** The approval a user-signed ERC-20 sell needs before the swap; native MON never needs one. */
function approvalFor(input: QuoteInput, spender: string | undefined, currentAllowance?: string) {
  if (isNativeMon(input.inputMint) || !spender) return { required: false };
  return { required: true, token: input.inputMint, spender, amount: input.amount, currentAllowance };
}

onchainRouter.post("/quote", async (request, response, next) => {
  try {
    const input = quoteSchema.parse(request.body);
    if (!input.walletAddress) {
      response.status(400).json({ error: "Connect a Monad wallet before requesting a firm quote." });
      return;
    }
    if (input.router === "kuru") {
      const quote = await kuru.quote({
        userAddress: input.walletAddress,
        tokenIn: input.inputMint,
        tokenOut: input.outputMint,
        amount: input.amount,
        slippageBps: input.slippageBps,
        referrerAddress: config.kuru.referrerAddress,
        referrerFeeBps: config.kuru.referrerFeeBps
      });
      const { quoteId, expiresAt } = cacheQuote(input, quote);
      response.json({
        quoteId,
        expiresAt,
        chain: "monad",
        router: "kuru",
        source: "Kuru Flow · Monad",
        observedAt: Date.now(),
        outAmount: quote.output,
        minimumOutAmount: quote.minOut,
        // ERC-20 inputs approve the Kuru Flow router named in the quote, for the exact amount.
        allowanceRequired: !isNativeMon(input.inputMint),
        routePlan: [{ source: "Kuru Flow" }]
      });
      return;
    }
    if (!config.zeroEx.apiKey) {
      response.status(503).json({ error: "0x routing is not configured", hint: "Set ZEROEX_API_KEY on the server, or use Kuru Flow." });
      return;
    }
    const params = new URLSearchParams({
      chainId: String(config.network.chainId),
      sellToken: zeroExToken(input.inputMint),
      buyToken: zeroExToken(input.outputMint),
      sellAmount: input.amount,
      taker: input.walletAddress,
      slippageBps: String(input.slippageBps)
    });
    const result = await fetchJson<ZeroExEvmQuote>(`${config.zeroEx.apiUrl}/swap/allowance-holder/quote?${params}`, {
      headers: { "0x-api-key": config.zeroEx.apiKey, "0x-version": "v2" }
    });
    const { quoteId, expiresAt } = cacheQuote(input, result);
    response.json({
      quoteId,
      expiresAt,
      chain: "monad",
      router: "0x",
      source: "0x AllowanceHolder · Monad",
      observedAt: Date.now(),
      outAmount: result.buyAmount,
      minimumOutAmount: result.minBuyAmount,
      price: result.price,
      priceImpactPct: result.estimatedPriceImpact,
      allowanceRequired: Boolean(result.issues?.allowance),
      routePlan: result.route?.fills ?? []
    });
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
    // A quote is only good for the order it was priced against; letting a changed amount or token through would sign it.
    if (!matchesOrder(cached.order, input)) {
      response.status(409).json({ error: "Order changed; request a fresh quote" });
      return;
    }
    quoteCache.delete(quoteId);
    if (cached.router === "kuru") {
      const quote = cached.quote as KuruQuote;
      response.json({
        source: "Kuru Flow · Monad",
        router: "kuru",
        chain: "monad",
        signingMode: "user-wallet",
        transaction: { to: quote.transaction.to, data: quote.transaction.data, value: quote.transaction.value, chainId: config.network.chainId },
        approval: approvalFor(input, quote.transaction.to)
      });
      return;
    }
    const quote = cached.quote as ZeroExEvmQuote;
    const allowance = quote.issues?.allowance;
    response.json({
      source: "0x AllowanceHolder · Monad",
      router: "0x",
      chain: "monad",
      signingMode: "user-wallet",
      transaction: { ...quote.transaction, chainId: config.network.chainId },
      approval: allowance ? approvalFor(input, allowance.spender || quote.allowanceTarget, allowance.actual) : { required: false }
    });
  } catch (error) { next(error); }
});

/** DexScreener search narrowed to Monad, deepest pair per token: candidates for the desk's ticker box. */
onchainRouter.get("/search", async (request, response, next) => {
  try {
    const query = z.string().trim().min(1).max(80).parse(request.query.q);
    response.json(await runResearchTool("monad_token_search", { query }).then((result) => (result as { evidence?: unknown }).evidence ?? { candidates: [] }));
  } catch (error) { next(error); }
});

onchainRouter.get("/portfolio/:wallet", async (request, response, next) => {
  try {
    const walletAddress = evmAddress.parse(request.params.wallet);
    const tokens = z.string().max(600).optional().parse(request.query.tokens)?.split(",").map((token) => token.trim()).filter(Boolean) ?? [];
    response.json(await monadWalletPortfolio(walletAddress, tokens));
  } catch (error) { next(error); }
});

/** Perpl perps context for the desk (mark / oracle / OI / 24h change per market). */
onchainRouter.get("/perps", async (_request, response, next) => {
  try {
    response.json(await getPerpl().tickers());
  } catch (error) { next(error); }
});

/** Nansen smart-money netflows and recent DEX trades on Monad; 200 with `error` when Nansen is not configured. */
onchainRouter.get("/smart-money", async (request, response, next) => {
  try {
    const token = evmAddress.optional().parse(request.query.token || undefined)?.toLowerCase();
    const nansen = getNansen();
    const [netflows, trades] = await Promise.all([nansen.netflows({ limit: 40 }), nansen.dexTrades({ token, limit: 100 })]);
    response.json({
      source: "nansen",
      configured: nansen.configured,
      observedAt: Date.now(),
      netflows: netflows.data,
      trades: trades.data,
      error: netflows.error ?? trades.error
    });
  } catch (error) { next(error); }
});

/** Nansen flow intelligence for one token (smart traders / whales / top PnL / fresh wallets). */
onchainRouter.get("/smart-money/:token/flows", async (request, response, next) => {
  try {
    const token = evmAddress.parse(request.params.token).toLowerCase();
    const timeframe = z.enum(["5m", "1h", "6h", "12h", "1d", "7d"]).default("1d").parse(request.query.timeframe);
    response.json(await getNansen().flowIntelligence(token, timeframe));
  } catch (error) { next(error); }
});
