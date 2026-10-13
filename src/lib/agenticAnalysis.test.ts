import { describe, expect, it } from "vitest";
import type { Candle, OnchainMarket } from "../types";
import { analysisFlowFromWindows, analyzeToken } from "./agenticAnalysis";

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
      flow: { label: "1h", buyUsd: 80_000, sellUsd: 50_000 },
      provider: { get_indicators: { sentiment: "bullish" }, intelligence_signals: [] }
    });
    expect(result.setups).toHaveLength(2);
    expect(result.support).toBeLessThan(result.resistance);
    expect(result.netFlowUsd).toBe(30_000);
    expect(result.flowWindow).toBe("1H");
    expect(result.summary).toContain("over the last 1H");
    expect(result.setups.every((setup) => setup.confidence >= 0 && setup.confidence <= 100)).toBe(true);
    expect(result.setups[0].conditions.map((condition) => condition.label)).toContain("Net flow (1H) turns positive");
  });

  it("detects whale distribution in market intelligence", () => {
    const result = analyzeToken({ market, candles, flow: null, provider: { anomalies: [{ summary: "Whale sell distribution detected" }] } });
    expect(result.whaleSellRisk).toBe(true);
    expect(result.netFlowUsd).toBeNull();
    expect(result.flowWindow).toBeNull();
    expect(result.summary).toContain("still resolving");
  });

  it("adapts the named flow window and stays null when the poll carried no windows", () => {
    const windows = [
      { label: "5m" as const, buyUsd: 1, sellUsd: 2, net: -1, buys: 1, sells: 1, unpriced: 0, aggressor: null },
      { label: "1h" as const, buyUsd: 80_000, sellUsd: 50_000, net: 30_000, buys: 9, sells: 4, unpriced: 1, aggressor: 0.6 }
    ];
    expect(analysisFlowFromWindows(windows)).toEqual({ label: "1h", buyUsd: 80_000, sellUsd: 50_000 });
    expect(analysisFlowFromWindows(windows, "15m")).toBeNull();
    expect(analysisFlowFromWindows(undefined)).toBeNull();
  });
});
