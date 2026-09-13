import { describe, expect, it } from "vitest";
import type { TapePrint } from "../../shared/wire";
import { AGENT_SIGNAL_MIN_USD, filterRecentOrderFlow, isLargeAgentSignal } from "./agentOrderFlow";

const NOW = 1_800_000_000_000;
const print = (overrides: Partial<TapePrint> = {}): TapePrint => ({
  pair: "pair", dex: "jupiter", tx: "tx", time: NOW - 60_000,
  side: "buy", usd: 2_500, source: "own", ...overrides
});

describe("standalone agent order-flow filters", () => {
  it("never promotes social fills below $1,000", () => {
    expect(isLargeAgentSignal({ usd: AGENT_SIGNAL_MIN_USD })).toBe(true);
    expect(isLargeAgentSignal({ usd: AGENT_SIGNAL_MIN_USD - 0.01 })).toBe(false);
    expect(isLargeAgentSignal({ usd: null })).toBe(false);
    const fills = [{ usd: 20 }, { usd: 1_500 }, { usd: 999 }];
    expect(fills.filter((fill) => isLargeAgentSignal(fill))).toEqual([{ usd: 1_500 }]);
  });

  it("filters by recent window, minimum size, and requested side", () => {
    const rows = [
      print({ tx: "match" }),
      print({ tx: "small", usd: 999 }),
      print({ tx: "old", time: NOW - 16 * 60_000 }),
      print({ tx: "sell", side: "sell" })
    ];
    expect(filterRecentOrderFlow(rows, { now: NOW, windowMinutes: 15, minUsd: 1_000, side: "buy" }).map((row) => row.tx)).toEqual(["match"]);
  });
});
