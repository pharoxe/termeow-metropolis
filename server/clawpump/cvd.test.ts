import { describe, expect, it } from "vitest";
import { computeCvd } from "./cvd";

describe("computeCvd", () => {
  it("sums buy volume and subtracts sell volume oldest to newest", () => {
    const result = computeCvd([
      { time: 3_000, kind: "sell", volumeUsd: 40, txHash: "b" },
      { time: 1_000, kind: "buy", volumeUsd: 100, txHash: "a" },
      { time: 2_000, kind: "buy", volumeUsd: 25, txHash: "c" }
    ]);
    expect(result.cvd).toBe(85);
    expect(result.buyUsd).toBe(125);
    expect(result.sellUsd).toBe(40);
    expect(result.series.map((point) => point.value)).toEqual([100, 125, 85]);
  });

  it("returns null cvd for an empty window", () => {
    const result = computeCvd([]);
    expect(result.cvd).toBeNull();
    expect(result.buyCount).toBe(0);
    expect(result.sellCount).toBe(0);
    expect(result.buyCountRecent).toBe(0);
    expect(result.sellCountRecent).toBe(0);
    expect(result.buyUsdRecent).toBe(0);
    expect(result.sellUsdRecent).toBe(0);
    expect(result.spanMs).toBe(0);
    expect(result.flow).toBe("flat");
  });

  it("counts buys and sells on the full tape", () => {
    const result = computeCvd([
      { time: 3_000, kind: "sell", volumeUsd: 40, txHash: "b" },
      { time: 1_000, kind: "buy", volumeUsd: 100, txHash: "a" },
      { time: 2_000, kind: "buy", volumeUsd: 25, txHash: "c" }
    ]);
    expect(result.buyCount).toBe(2);
    expect(result.sellCount).toBe(1);
    expect(result.buyCountRecent).toBe(2);
    expect(result.sellCountRecent).toBe(1);
    expect(result.buyUsdRecent).toBe(125);
    expect(result.sellUsdRecent).toBe(40);
    expect(result.spanMs).toBe(2_000);
    expect(result.flow).toBe("buy");
  });

  it("treats equal recent USD as flat flow", () => {
    const now = Date.now();
    const result = computeCvd([
      { time: now - 60_000, kind: "buy", volumeUsd: 50, txHash: "a" },
      { time: now, kind: "sell", volumeUsd: 50, txHash: "b" }
    ]);
    expect(result.flow).toBe("flat");
    expect(result.buyUsdRecent).toBe(result.sellUsdRecent);
  });

  it("uses the full tape as recent when span is under 2h", () => {
    const now = Date.now();
    const first = now - (90 * 60 * 1000);
    const result = computeCvd([
      { time: first, kind: "buy", volumeUsd: 10, txHash: "a" },
      { time: now, kind: "sell", volumeUsd: 4, txHash: "b" }
    ]);
    expect(result.spanMs).toBe(now - first);
    expect(result.buyCount).toBe(1);
    expect(result.sellCount).toBe(1);
    expect(result.buyCountRecent).toBe(1);
    expect(result.sellCountRecent).toBe(1);
    expect(result.buyUsdRecent).toBe(10);
    expect(result.sellUsdRecent).toBe(4);
    expect(result.flow).toBe("buy");
  });

  it("cuts recent window at lastTradeTime - 2h when tape spans longer", () => {
    const now = Date.now();
    const old = now - (3 * 60 * 60 * 1000);
    const recent = now - (20 * 60 * 1000);
    const result = computeCvd([
      { time: old, kind: "buy", volumeUsd: 400, txHash: "old-buy" },
      { time: old + 1_000, kind: "sell", volumeUsd: 50, txHash: "old-sell" },
      { time: recent, kind: "sell", volumeUsd: 80, txHash: "new-sell" },
      { time: recent + 5_000, kind: "buy", volumeUsd: 30, txHash: "new-buy" }
    ]);
    expect(result.buyCount).toBe(2);
    expect(result.sellCount).toBe(2);
    expect(result.buyUsd).toBe(430);
    expect(result.sellUsd).toBe(130);
    expect(result.buyCountRecent).toBe(1);
    expect(result.sellCountRecent).toBe(1);
    expect(result.buyUsdRecent).toBe(30);
    expect(result.sellUsdRecent).toBe(80);
    expect(result.flow).toBe("sell");
    expect(result.spanMs).toBe((recent + 5_000) - old);
  });

  it("includes a print sitting exactly on the 2h cutoff", () => {
    const last = Date.now();
    const cutoff = last - (2 * 60 * 60 * 1000);
    const older = cutoff - 1;
    const result = computeCvd([
      { time: older, kind: "buy", volumeUsd: 999, txHash: "before" },
      { time: cutoff, kind: "sell", volumeUsd: 7, txHash: "on-cut" },
      { time: last, kind: "sell", volumeUsd: 3, txHash: "last" }
    ]);
    expect(result.spanMs).toBe(last - older);
    expect(result.buyCountRecent).toBe(0);
    expect(result.sellCountRecent).toBe(2);
    expect(result.buyUsdRecent).toBe(0);
    expect(result.sellUsdRecent).toBe(10);
    expect(result.flow).toBe("sell");
  });
});
