import type { WalletAsset, WalletPortfolio } from "../../shared/portfolio.js";
import { config } from "../config.js";
import { fetchJson } from "../lib/http.js";

type BlockscoutBalance = {
  value?: string;
  token?: { address_hash?: string; address?: string; decimals?: string | number; symbol?: string; name?: string; icon_url?: string | null; exchange_rate?: string | number | null };
};

/** Native ETH plus positive ERC-20 holdings from Robinhood Chain's Blockscout index. */
export async function robinhoodWalletPortfolio(walletAddress: string, load: typeof fetchJson = fetchJson): Promise<WalletPortfolio> {
  const rpcBody = { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [walletAddress, "latest"] };
  const [native, tokens] = await Promise.allSettled([
    load<{ result?: string }>(config.robinhood.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rpcBody) }),
    load<BlockscoutBalance[]>(`https://robinhoodchain.blockscout.com/api/v2/addresses/${encodeURIComponent(walletAddress)}/token-balances`)
  ]);
  if (native.status === "rejected" && tokens.status === "rejected") throw new Error("Robinhood wallet balances are unavailable");
  const assets: WalletAsset[] = [];
  if (native.status === "fulfilled" && native.value.result && /^0x[\da-f]+$/i.test(native.value.result)) {
    const amount = Number(BigInt(native.value.result)) / 1e18;
    if (amount > 0) assets.push({ mint: "ETH", symbol: "ETH", name: "Ether", amount, decimals: 18, priceUsd: null, valueUsd: null });
  }
  if (tokens.status === "fulfilled") {
    for (const row of tokens.value) {
      const token = row.token ?? {};
      const mint = token.address_hash ?? token.address ?? "";
      const decimals = Number(token.decimals);
      if (!/^0x[\da-f]{40}$/i.test(mint) || !Number.isInteger(decimals) || decimals < 0 || !/^\d+$/.test(row.value ?? "")) continue;
      const amount = Number(BigInt(row.value!)) / 10 ** decimals;
      if (!(amount > 0)) continue;
      const rawPrice = token.exchange_rate == null ? Number.NaN : Number(token.exchange_rate);
      const priceUsd = Number.isFinite(rawPrice) ? rawPrice : null;
      assets.push({ mint, symbol: token.symbol || mint, name: token.name || "Robinhood token", imageUrl: token.icon_url || null, amount, decimals, priceUsd, valueUsd: priceUsd == null ? null : amount * priceUsd });
    }
  }
  return { walletAddress, assets: assets.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)), partial: native.status === "rejected" || tokens.status === "rejected", valuationUnavailable: assets.some(asset => asset.priceUsd == null) };
}
