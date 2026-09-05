import { describe, expect, it } from "vitest";
import type { Candle, OnchainMarket } from "../types";
import { analyzeToken } from "./agenticAnalysis";
import { magicBlockSessionAdapter } from "./agenticExecution";

const candles: Candle[] = Array.from({ length: 120 }, (_, index) => {
  const close = 0.22 + Math.sin(index / 7) * 0.02 + index * 0.00005;
  return { time: index, open: close - 0.001, high: close + 0.003, low: close - 0.003, close, volume: 1000 + index };
});

const market: OnchainMarket = {
  instrumentId: "ANSEM/USD", mint: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", symbol: "ANSEM", name: "The Black Bull",
  quoteSymbol: "USD", priceUsd: candles.at(-1)!.close, change24hPct: 1, volume24hUsd: 1_000_000, liquidityUsd: 500_000,
  marketCapUsd: 200_000_000, fdvUsd: null, pairAddress: "pair", dex: "pumpswap", observedAt: 1, source: "test", degraded: false,
  notes: [], provider: {}, candles, signals: []
};

describe("agentic analysis", () => {
  it("builds two bounded, condition-driven trade setups", () => {
    const result = analyzeToken({
      market,
      candles,
      cvd: { buyUsdRecent: 80_000, sellUsdRecent: 50_000, flow: "buy" },
      provider: { get_indicators: { sentiment: "bullish" }, intelligence_signals: [] }
    });
    expect(result.setups).toHaveLength(2);
    expect(result.support).toBeLessThan(result.resistance);
    expect(result.cvdDelta).toBe(30_000);
    expect(result.setups.every((setup) => setup.confidence >= 0 && setup.confidence <= 100)).toBe(true);
    expect(result.setups[0].conditions.map((condition) => condition.label)).toContain("CVD turns positive");
  });

  it("detects whale distribution in ClawPump intelligence", () => {
    const result = analyzeToken({ market, candles, cvd: null, provider: { anomalies: [{ summary: "Whale sell distribution detected" }] } });
    expect(result.whaleSellRisk).toBe(true);
  });

  it("refuses execution while session authorization is unavailable", async () => {
    await expect(magicBlockSessionAdapter.execute({ mint: market.mint, symbol: market.symbol, setup: analyzeToken({ market, candles, cvd: null, provider: {} }).setups[0], notionalUsd: 100, maxSlippageBps: 50 }))
      .rejects.toThrow("No transaction was submitted");
  });
});
