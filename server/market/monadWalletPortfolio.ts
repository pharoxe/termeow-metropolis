import type { WalletAsset, WalletPortfolio } from "../../shared/portfolio.js";
import { config } from "../config.js";
import { errorMessage, fetchJson } from "../lib/http.js";
import { evmRpc } from "../tape/monad/rpc.js";
import { dexScreenerTokensUrl, parseDexScreenerTokenPrices } from "../tape/monad/price.js";

/**
 * Native MON plus ERC-20 balances read straight from Monad over JSON-RPC (no indexer key needed): the network's core
 * assets (WMON, USDC, AUSD) plus any tokens the caller names (the instrument on screen, recent trades). Prices come from
 * DexScreener's deepest Monad pair; a token it does not list stays unpriced rather than guessed.
 */
const BALANCE_OF = "0x70a08231";
const DECIMALS = "0x313ce567";
const SYMBOL = "0x95d89b41";
const MAX_EXTRA_TOKENS = 12;

type Meta = { symbol: string; name: string; decimals: number };
const KNOWN: Record<string, Meta> = {
  [config.network.tokens.wmon]: { symbol: "WMON", name: "Wrapped MON", decimals: 18 },
  [config.network.tokens.usdc]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
  ...(config.network.tokens.ausd ? { [config.network.tokens.ausd]: { symbol: "AUSD", name: "Agora Dollar", decimals: 6 } } : {})
};
const metaCache = new Map<string, Meta>();

export type PortfolioDeps = {
  rpc?: (method: string, params: unknown[]) => Promise<unknown>;
  fetchPrices?: (tokens: string[]) => Promise<Map<string, number>>;
};

function word(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** ABI string or bytes32 symbol, best effort. */
function decodeSymbol(hex: unknown): string | null {
  if (typeof hex !== "string" || !/^0x[0-9a-f]*$/i.test(hex) || hex.length < 66) return null;
  const raw = hex.slice(2);
  const fromBytes = (body: string) => Buffer.from(body, "hex").toString("utf8").replace(/\0+$/g, "").trim() || null;
  if (raw.length >= 192) {
    const length = parseInt(raw.slice(64, 128), 16);
    if (length > 0 && length <= 64) return fromBytes(raw.slice(128, 128 + length * 2));
  }
  return fromBytes(raw.slice(0, 64));
}

async function tokenMeta(token: string, rpc: NonNullable<PortfolioDeps["rpc"]>): Promise<Meta> {
  const known = KNOWN[token] ?? metaCache.get(token);
  if (known) return known;
  const [decimals, symbol] = await Promise.all([
    rpc("eth_call", [{ to: token, data: DECIMALS }, "latest"]),
    rpc("eth_call", [{ to: token, data: SYMBOL }, "latest"]).catch(() => null)
  ]);
  const parsed = typeof decimals === "string" && /^0x[0-9a-f]+$/i.test(decimals) ? Number(BigInt(decimals)) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36) throw new Error(`decimals() unreadable for ${token}`);
  const label = decodeSymbol(symbol) ?? `${token.slice(0, 6)}…`;
  const meta = { symbol: label, name: label, decimals: parsed };
  metaCache.set(token, meta);
  return meta;
}

async function dexScreenerPrices(tokens: string[]): Promise<Map<string, number>> {
  if (!tokens.length) return new Map();
  const body = await fetchJson<unknown>(dexScreenerTokensUrl("monad", tokens));
  return parseDexScreenerTokenPrices(body, new Set(tokens), "monad");
}

export async function monadWalletPortfolio(walletAddress: string, extraTokens: string[] = [], deps: PortfolioDeps = {}): Promise<WalletPortfolio> {
  const rpc = deps.rpc ?? ((method: string, params: unknown[]) => evmRpc(config.monad.rpcUrl, method, params));
  const fetchPrices = deps.fetchPrices ?? dexScreenerPrices;
  const tokens = [...new Set([...Object.keys(KNOWN), ...extraTokens.map((token) => token.toLowerCase()).filter((token) => /^0x[0-9a-f]{40}$/.test(token)).slice(0, MAX_EXTRA_TOKENS)])];
  let failures = 0;
  const native = await rpc("eth_getBalance", [walletAddress, "latest"]).catch(() => { failures += 1; return null; });
  const balances = await Promise.all(tokens.map(async (token) => {
    try {
      const raw = await rpc("eth_call", [{ to: token, data: `${BALANCE_OF}${word(walletAddress)}` }, "latest"]);
      if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw) || BigInt(raw) === 0n) return null;
      return { token, raw: BigInt(raw), meta: await tokenMeta(token, rpc) };
    } catch (error) {
      failures += 1;
      void errorMessage(error);
      return null;
    }
  }));
  const held = balances.filter((row): row is NonNullable<typeof row> => row !== null);
  const wmon = config.network.tokens.wmon;
  const prices = await fetchPrices([...new Set([wmon, ...held.map((row) => row.token)])]).catch(() => { failures += 1; return new Map<string, number>(); });
  const assets: WalletAsset[] = [];
  if (typeof native === "string" && /^0x[0-9a-f]+$/i.test(native) && BigInt(native) > 0n) {
    const amount = Number(BigInt(native)) / 1e18;
    const priceUsd = prices.get(wmon) ?? null;
    assets.push({ mint: "MON", symbol: "MON", name: "Monad", amount, decimals: 18, priceUsd, valueUsd: priceUsd == null ? null : amount * priceUsd });
  }
  for (const row of held) {
    const amount = Number(row.raw) / 10 ** row.meta.decimals;
    const stable = row.meta.symbol === "USDC" || row.meta.symbol === "AUSD";
    const priceUsd = prices.get(row.token) ?? (stable ? 1 : null);
    assets.push({ mint: row.token, symbol: row.meta.symbol, name: row.meta.name, amount, decimals: row.meta.decimals, priceUsd, valueUsd: priceUsd == null ? null : amount * priceUsd });
  }
  if (failures > 0 && assets.length === 0 && native === null) throw new Error("Monad wallet balances are unavailable");
  return {
    walletAddress,
    assets: assets.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)),
    partial: failures > 0,
    valuationUnavailable: assets.some((asset) => asset.priceUsd == null)
  };
}
