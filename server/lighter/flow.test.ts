import { describe, expect, it } from "vitest";
import { MINUTE_MS, alignTo } from "../flow/ledger.js";
import { parseTrades } from "../sources/lighter.js";
import recentTrades from "./__fixtures__/recentTrades-0.json";
import { LIGHTER_CHAIN, LighterFlow, marketPairRow, toFlowPrints } from "./flow.js";

const TRADES = parseTrades(recentTrades);
const LAST_TIME = Math.max(...TRADES.map((trade) => trade.time));
const NOW = LAST_TIME + 1_000;
const buyUsd = TRADES.filter((trade) => trade.takerSide === "buy").reduce((acc, trade) => acc + (trade.usd ?? 0), 0);
const sellUsd = TRADES.filter((trade) => trade.takerSide === "sell").reduce((acc, trade) => acc + (trade.usd ?? 0), 0);

describe("toFlowPrints", () => {
  it("keys prints by venue and market id with the taker side and the trade id as tx", () => {
    const [print] = toFlowPrints(0, TRADES.slice(0, 1));
    expect(print).toEqual({ chain: "lighter", pair: "0", tx: "29600423478", time: 1788698180173, side: "buy", usd: 749.873125, source: "lighter" });
  });

  it("marketPairRow is a Tier A synthetic pool with unknown fields null", () => {
    expect(marketPairRow(25)).toMatchObject({ chain: LIGHTER_CHAIN, dex: "lighter", pairAddress: "25", tier: "A", share24: null, liquidityUsd: null, sources: ["lighter"] });
  });
});

describe("LighterFlow", () => {
  it("ingests trades once (dedupe by trade id) and reports windows and bars", () => {
    const flow = new LighterFlow();
    expect(flow.ingestTrades(0, TRADES)).toEqual({ accepted: 20, duplicates: 0 });
    expect(flow.ingestTrades(0, TRADES)).toEqual({ accepted: 0, duplicates: 20 });

    const result = flow.flow(0, "1m", alignTo(NOW - 10 * MINUTE_MS, MINUTE_MS), NOW, NOW);
    expect(result.coverage.firstPrintAt).toBe(Math.min(...TRADES.map((trade) => trade.time)));
    expect(result.windows.map((window) => window.label)).toEqual(["1m", "5m", "15m", "1h"]);
    for (const window of result.windows) {
      expect(window).toMatchObject({ buys: 12, sells: 8, unpriced: 0 });
      expect(window.buyUsd).toBeCloseTo(buyUsd, 6);
      expect(window.net).toBeCloseTo(buyUsd - sellUsd, 6);
      expect(window.aggressor).toBeCloseTo(buyUsd / (buyUsd + sellUsd), 9);
    }
    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]).toMatchObject({ t: alignTo(LAST_TIME, MINUTE_MS), buys: 12, sells: 8 });
    expect(result.bars[0].cvd).toBeCloseTo(buyUsd - sellUsd, 6);
  });

  it("keeps markets apart and returns empties for an unknown market", () => {
    const flow = new LighterFlow();
    flow.ingestTrades(0, TRADES);
    const other = flow.flow(1, "5m", NOW - 60 * MINUTE_MS, NOW, NOW);
    expect(other.bars).toEqual([]);
    expect(other.windows.every((window) => window.buys === 0 && window.aggressor === null)).toBe(true);
    expect(other.coverage.firstPrintAt).toBeNull();
    expect(flow.firstPrintAt(0)).not.toBeNull();
  });

  it("rejects unknown intervals", () => {
    expect(() => new LighterFlow().flow(0, "7m", 0, NOW, NOW)).toThrow(RangeError);
  });
});
