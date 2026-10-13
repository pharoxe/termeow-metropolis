import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { fetchAssetUsd } from "./credits.js";

describe("asset price providers", () => {
  it("falls back to DexScreener when CoinGecko rate limits a MON quote", async () => {
    const wmon = config.network.tokens.wmon;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("coingecko")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify([
        { chainId: "monad", priceUsd: "3.42", liquidity: { usd: 1_000_000 }, baseToken: { address: wmon }, quoteToken: { address: "0x1111111111111111111111111111111111111111" } }
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await expect(fetchAssetUsd("MON", fetcher)).resolves.toBe(3.42);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when every provider returns unusable data", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(fetchAssetUsd("MON", fetcher)).rejects.toThrow("temporarily unavailable");
  });
});
