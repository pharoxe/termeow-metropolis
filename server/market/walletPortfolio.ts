import { config } from "../config.js";
import { fetchJson } from "../lib/http.js";
import type { WalletAsset, WalletPortfolio } from "../../shared/portfolio.js";
const PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const WSOL = "So11111111111111111111111111111111111111112";
type Rpc = (method: string, params: unknown[]) => Promise<any>;
export async function walletRpc(method: string, params: unknown[]): Promise<any> {
  let failure: unknown;
  for (const url of [config.rpc.primary, config.rpc.fallback].filter((x): x is string => Boolean(x))) {
    try {
      const body = await fetchJson<{ result?: unknown; error?: unknown }>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (body.error || body.result == null) throw new Error("Solana RPC returned no usable result");
      return body.result;
    } catch (error) { failure = error; }
  }
  throw failure;
}
export async function walletPortfolio(walletAddress: string, rpc: Rpc = walletRpc, load: typeof fetchJson = fetchJson): Promise<WalletPortfolio> {
  const results = await Promise.allSettled([
    rpc("getBalance", [walletAddress, { commitment: "confirmed" }]),
    ...PROGRAMS.map(programId => rpc("getTokenAccountsByOwner", [walletAddress, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]))
  ]);
  if (results.every(r => r.status === "rejected")) throw new Error("Wallet balances are unavailable");
  const assets = new Map<string, WalletAsset>();
  const native = results[0];
  if (native.status === "fulfilled" && native.value.value > 0) assets.set("SOL", { mint: "SOL", name: "Solana", symbol: "SOL", amount: native.value.value / 1e9, decimals: 9, priceUsd: null, valueUsd: null });
  for (const result of results.slice(1)) {
    if (result.status !== "fulfilled") continue;
    for (const account of result.value.value ?? []) {
      const info = account.account?.data?.parsed?.info;
      const amount = Number(info?.tokenAmount?.uiAmountString);
      if (!info?.mint || !Number.isFinite(amount) || amount <= 0) continue;
      const existing = assets.get(info.mint);
      if (existing) existing.amount += amount;
      else assets.set(info.mint, { mint: info.mint, symbol: info.mint, name: "Solana token", amount, decimals: info.tokenAmount.decimals, priceUsd: null, valueUsd: null });
    }
  }
  const mints = [...new Set([...assets.keys()].map(m => m === "SOL" ? WSOL : m))];
  // Bound per-request price work; unpriced holdings remain visible with unknown value.
  for (let i = 0; i < Math.min(mints.length, 300); i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const pairs = await load<any[]>(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`);
      for (const mint of batch) {
        const pair = pairs.filter(p => p.chainId === "solana" && p.baseToken?.address === mint && Number(p.priceUsd) > 0)
          .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
        if (!pair) continue;
        for (const key of mint === WSOL ? ["SOL", WSOL] : [mint]) {
          const asset = assets.get(key);
          if (!asset) continue;
          asset.priceUsd = Number(pair.priceUsd);
          asset.valueUsd = asset.amount * asset.priceUsd;
          asset.imageUrl = typeof pair.info?.imageUrl === "string" ? pair.info.imageUrl : asset.imageUrl;
          if (key !== "SOL") { asset.symbol = pair.baseToken.symbol || mint; asset.name = pair.baseToken.name || "Solana token"; }
        }
      }
    } catch { /* Keep balances when pricing is unavailable. */ }
  }
  return { walletAddress, assets: [...assets.values()].sort((a,b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)), partial: results.some(r => r.status === "rejected"), valuationUnavailable: [...assets.values()].some(a => a.priceUsd === null) };
}
