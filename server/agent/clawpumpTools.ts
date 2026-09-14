import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { clawpumpMcp } from "../clawpump/mcp.js";
const mint = z.string().refine(value => { try { return new PublicKey(value).toBase58() === value; } catch { return false; } }, "Expected a Solana mint");
const schemas = {
  token_search: z.object({ query: z.string().trim().min(1).max(100) }).strict(),
  get_price: z.object({ tokens: z.string().max(230).refine(value => value.split(",").length <= 5 && value.split(",").every(token => /^[a-zA-Z0-9]{1,44}$/.test(token.trim()))) }).strict(),
  intelligence_market: z.object({ token: mint }).strict(),
  intelligence_signals: z.object({}).strict(), intelligence_macro: z.object({}).strict(), intelligence_perps: z.object({}).strict(),
  get_news_feed: z.object({ category: z.enum(["all", "stock", "crypto", "tech"]).default("crypto"), query: z.string().max(100).optional(), limit: z.number().int().min(1).max(10).default(5) }).strict(),
  arbitrage_prices: z.object({ input_mint: mint, output_mint: mint }).strict(),
  swap_quote: z.object({ input_mint: mint, output_mint: mint, amount: z.string().regex(/^[1-9]\d{0,19}$/).refine(value => BigInt(value) <= 18446744073709551615n), slippage_bps: z.number().int().min(1).max(500).default(50) }).strict()
};
export function parseClawpumpTool(name: string, args: unknown) {
  const upstream = name.replace(/^clawpump_/, "");
  if (!Object.hasOwn(schemas, upstream)) throw new Error("ClawPump tool is not available to the voice agent");
  return { upstream, args: schemas[upstream as keyof typeof schemas].parse(args) };
}
const cache = new Map<string, { at: number; result: unknown }>();
const pending = new Map<string, Promise<unknown>>();
export async function runClawpumpTool(name: string, raw: unknown) {
  const { upstream, args } = parseClawpumpTool(name, raw);
  const key = JSON.stringify([upstream, args]);
  const ttl = upstream === "swap_quote" ? 3000 : upstream === "get_price" ? 10_000 : 30_000;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.result;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const result = await clawpumpMcp.call(upstream, args);
    const encoded = JSON.stringify(result);
    const compact = encoded.length <= 18_000 ? result : { ok: result.ok, tool: upstream, truncated: true, excerpt: encoded.slice(0, 18_000), note: "Partial provider response; do not infer omitted evidence." };
    const output = { source: "ClawPump", observedAt: new Date().toISOString(), execution: false, evidence: compact };
    if (result.ok) { if (cache.size >= 200) cache.delete(cache.keys().next().value!); cache.set(key, { at: Date.now(), result: output }); }
    return output;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
