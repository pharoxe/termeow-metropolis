import { describe, expect, it, vi } from "vitest";
import { fetchAssetUsd } from "./credits.js";

describe("asset price providers", () => {
  it("falls back to Jupiter when CoinGecko rate limits a SOL quote", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("coingecko")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({
        So11111111111111111111111111111111111111112: { usdPrice: 142.37 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await expect(fetchAssetUsd("SOL", fetcher)).resolves.toBe(142.37);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when every provider returns unusable data", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(fetchAssetUsd("SOL", fetcher)).rejects.toThrow("temporarily unavailable");
  });
});
