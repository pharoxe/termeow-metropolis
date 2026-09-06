import { describe, expect, it } from "vitest";
import type { FlowBar, LighterMarket, LighterTrade } from "../../shared/wire";
import {
  EM_DASH,
  LADDER_DEPTH,
  bookSourceLabel,
  buildLadder,
  cvdLine,
  fmtBps,
  fmtNum,
  fundingLine,
  marketRow,
  sizeBarPct,
  sortMarketsByVolume,
  spreadBps,
  tapeRow,
  tapeRows
} from "./lighterPanel";

const NOW = 1_800_000_000_000;

function market(over: Partial<LighterMarket> = {}): LighterMarket {
  return { marketId: 0, symbol: "ETH", status: "active", markPrice: 2503, indexPrice: 2502, lastPrice: 2503.15, change24Pct: 1.25, volume24Usd: 1_200_000, trades24: 10, sizeDecimals: 4, priceDecimals: 2, ...over };
}

function trade(over: Partial<LighterTrade> = {}): LighterTrade {
  return { id: "t1", tx: "0x1", time: NOW - 12_000, price: 2503.15, size: 0.0998, usd: 249.81, takerSide: "buy", liquidation: false, ...over };
}

describe("sizeBarPct", () => {
  it("scales against the max and clamps to 100", () => {
    expect(sizeBarPct(5, 10)).toBe(50);
    expect(sizeBarPct(10, 10)).toBe(100);
    expect(sizeBarPct(20, 10)).toBe(100);
  });

  it("is 0 when there is nothing to scale against", () => {
    expect(sizeBarPct(5, 0)).toBe(0);
    expect(sizeBarPct(0, 10)).toBe(0);
    expect(sizeBarPct(Number.NaN, 10)).toBe(0);
  });
});

describe("buildLadder", () => {
  it("orders asks farthest→best and bids best→farthest with running totals on a shared scale", () => {
    const ladder = buildLadder({
      asks: [{ price: 101, size: 1 }, { price: 100.5, size: 2 }, { price: 102, size: 4 }],
      bids: [{ price: 99, size: 3 }, { price: 99.5, size: 1 }]
    });
    expect(ladder.maxSize).toBe(4);
    expect(ladder.asks.map((row) => row.price)).toEqual([102, 101, 100.5]);
    expect(ladder.asks.map((row) => row.total)).toEqual([7, 3, 2]);
    expect(ladder.bids.map((row) => row.price)).toEqual([99.5, 99]);
    expect(ladder.bids.map((row) => row.total)).toEqual([1, 4]);
    expect(ladder.asks.find((row) => row.price === 102)?.pct).toBe(100);
    expect(ladder.bids[0]!.pct).toBe(25);
  });

  it("caps each side at the depth, drops zero/non-finite levels and tolerates a null book", () => {
    const asks = Array.from({ length: 15 }, (_, index) => ({ price: 100 + index, size: 1 }));
    const ladder = buildLadder({ asks, bids: [{ price: 99, size: 0 }, { price: Number.NaN, size: 2 }] });
    expect(ladder.asks).toHaveLength(LADDER_DEPTH);
    expect(ladder.asks[ladder.asks.length - 1]!.price).toBe(100);
    expect(ladder.bids).toEqual([]);
    expect(buildLadder(null)).toEqual({ asks: [], bids: [], maxSize: 0 });
  });

  it("does not mutate the input arrays", () => {
    const asks = [{ price: 102, size: 1 }, { price: 101, size: 1 }];
    buildLadder({ asks, bids: [] });
    expect(asks.map((level) => level.price)).toEqual([102, 101]);
  });
});

describe("spreadBps", () => {
  it("computes (ask-bid)/mid in bps", () => {
    expect(spreadBps(100.01, 99.99)).toBeCloseTo(2, 6);
  });

  it("is null when either side is missing or non-positive", () => {
    expect(spreadBps(null, 100)).toBeNull();
    expect(spreadBps(100, undefined)).toBeNull();
    expect(spreadBps(0, 0)).toBeNull();
  });
});

describe("formatting", () => {
  it("renders nulls as an em-dash and honours decimals", () => {
    expect(fmtNum(null, 2)).toBe(EM_DASH);
    expect(fmtNum(2503.156, 2)).toBe("2,503.16");
    expect(fmtNum(0.0998, 4)).toBe("0.0998");
    expect(fmtBps(null)).toBe(EM_DASH);
    expect(fmtBps(0.799)).toBe("0.80 bps");
    expect(fmtBps(12.34)).toBe("12.3 bps");
  });

  it("funding line shows the raw venue rate and direction, em-dash when absent", () => {
    expect(fundingLine({ rate: 0.0012, direction: "long", at: NOW })).toBe("FUND 0.0012 · LONG");
    expect(fundingLine(null)).toBe(`FUND ${EM_DASH}`);
  });

  it("book source label distinguishes stream, stale rest and no book", () => {
    expect(bookSourceLabel({ source: "stream" })).toBe("STREAM");
    expect(bookSourceLabel({ source: "rest", stale: true })).toBe("REST · STALE");
    expect(bookSourceLabel({ source: null })).toBe("NO BOOK");
    expect(bookSourceLabel({ source: null, error: "timeout" })).toBe("NO BOOK · timeout");
    expect(bookSourceLabel(null)).toBe("NO BOOK");
  });
});

describe("tape rows", () => {
  it("maps taker side to BUY/up and SELL/dn, keeps the liquidation flag and ages the print", () => {
    expect(tapeRow(trade(), NOW, 2, 4)).toEqual({ key: "t1", side: "BUY", tone: "up", price: "2,503.15", size: "0.0998", usd: "$249.81", age: "12s", liq: false });
    const sell = tapeRow(trade({ takerSide: "sell", liquidation: true, usd: null }), NOW, 2, 4);
    expect(sell).toMatchObject({ side: "SELL", tone: "dn", liq: true, usd: EM_DASH });
  });

  it("caps the tape at the limit, newest first as given", () => {
    const trades = Array.from({ length: 40 }, (_, index) => trade({ id: `t${index}` }));
    expect(tapeRows(trades, NOW, 2, 4)).toHaveLength(30);
    expect(tapeRows(trades, NOW, 2, 4, 5).map((row) => row.key)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });
});

describe("cvdLine", () => {
  const bar = (cvd: number): FlowBar => ({ t: NOW, buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, unpricedBuys: 0, unpricedSells: 0, delta: 0, cvd });
  it("reads the last bar's running sum", () => {
    expect(cvdLine([bar(100), bar(-12_300)])).toBe("CVD -$12.3K · 2 bars");
    expect(cvdLine([bar(1500)])).toBe("CVD +$1.5K · 1 bars");
  });

  it("says so when there are no bars", () => {
    expect(cvdLine([])).toBe(`CVD ${EM_DASH} · no bars`);
    expect(cvdLine(null)).toBe(`CVD ${EM_DASH} · no bars`);
  });
});

describe("markets", () => {
  it("sorts by 24h volume desc with unknown volume last and does not mutate", () => {
    const input = [market({ marketId: 1, volume24Usd: null }), market({ marketId: 2, volume24Usd: 5 }), market({ marketId: 3, volume24Usd: 50 })];
    expect(sortMarketsByVolume(input).map((row) => row.marketId)).toEqual([3, 2, 1]);
    expect(input.map((row) => row.marketId)).toEqual([1, 2, 3]);
  });

  it("formats a market row and keeps nulls as em-dashes", () => {
    expect(marketRow(market())).toEqual({ key: 0, symbol: "ETH", last: "2,503.15", change: "+1.25%", changeTone: "up", vol: "$1.2M" });
    expect(marketRow(market({ lastPrice: null, change24Pct: null, volume24Usd: null }))).toMatchObject({ last: EM_DASH, change: EM_DASH, changeTone: "", vol: EM_DASH });
    expect(marketRow(market({ change24Pct: -3 })).changeTone).toBe("dn");
  });
});
