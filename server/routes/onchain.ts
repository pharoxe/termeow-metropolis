import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config.js";
import { clawpumpMcp } from "../clawpump/mcp.js";
import { getBoard, getHolders, getOnchainMarket, getTrenches, trenchSorts } from "../clawpump/market.js";
import { errorMessage, fetchJson } from "../lib/http.js";

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const quoteSchema = z.object({
  router: z.enum(["0x", "clawpump"]).default("0x"),
  inputMint: address,
  outputMint: address,
  amount: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(1).max(500).default(50),
  walletAddress: address.optional()
});

export const onchainRouter = Router();
type RouterId = "0x" | "clawpump";
const quoteCache = new Map<string, { expiresAt: number; router: RouterId; walletAddress?: string; quote: unknown }>();

type ZeroExInstruction = {
  accounts: Array<{ pubkey: number[]; is_signer: boolean; is_writable: boolean }>;
  data: number[];
  program_id: number[];
};
type ZeroExQuote = {
  address_lookup_tables?: string[];
  amount_out: number | string;
  min_amount_out: number | string;
  instructions: ZeroExInstruction[];
  route_plan?: Array<{ dex_label?: string }>;
  zid?: string;
};

async function zeroExTransaction(quote: ZeroExQuote, taker: string) {
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
        response.status(400).json({ error: "Connect the Solana wallet before requesting a firm 0x quote." });
        return;
      }
      const amountIn = Number(input.amount);
      if (!Number.isSafeInteger(amountIn)) {
        response.status(400).json({ error: "The atomic input amount is outside the supported range." });
        return;
      }
      const result = await fetchJson<ZeroExQuote>(`${config.zeroEx.apiUrl}/solana/swap-instructions`, {
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
      const quoteId = randomUUID();
      quoteCache.set(quoteId, { expiresAt: Date.now() + 60_000, router: "0x", walletAddress: input.walletAddress, quote: result });
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
    const quoteId = randomUUID();
    quoteCache.set(quoteId, { expiresAt: Date.now() + 60_000, router: "clawpump", walletAddress: input.walletAddress, quote: result.data });
    response.json({ quoteId, router: "clawpump", source: "ClawPump + Jupiter", observedAt: Date.now(), ...result });
  } catch (error) { next(error); }
});

onchainRouter.post("/transaction", async (request, response, next) => {
  try {
    const input = quoteSchema.extend({
      walletAddress: address,
      quoteId: z.string().uuid()
    }).parse(request.body);
    const cached = quoteCache.get(input.quoteId);
    if (!cached || cached.expiresAt < Date.now()) {
      response.status(409).json({ error: "Quote expired", hint: "Request a fresh router quote before building the transaction." });
      return;
    }
    if (cached.router !== input.router) {
      response.status(409).json({ error: "The selected router no longer matches the quoted route." });
      return;
    }
    if (cached.walletAddress && cached.walletAddress !== input.walletAddress) {
      response.status(409).json({ error: "The connected wallet no longer matches the quoted route." });
      return;
    }
    quoteCache.delete(input.quoteId);
    if (cached.router === "0x") {
      const transaction = await zeroExTransaction(cached.quote as ZeroExQuote, input.walletAddress);
      response.json({ source: "0x Solana Swap API", router: "0x", signingMode: "user-wallet", transaction });
      return;
    }
    const quoteResponse = findJupiterQuote(cached.quote);
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
    response.json({ source: "clawpump+jupiter", signingMode: "user-wallet", ...result });
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
