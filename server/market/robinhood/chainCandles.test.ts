import { describe, expect, it, vi } from "vitest";
import type { FlowPrint, PairRow } from "../../../shared/wire.js";
import type { EvmPoolRef } from "../../tape/robinhood/pools.js";
import { CHAIN_TIMING, MIN_FILL_SHARE, chainCandlesFor, livePrintsOutside, ownPrints, type ChainCandleDeps } from "./chainCandles.js";
import type { PoolCandleState, SwapCandleCache } from "./swapCache.js";
import type { TimedSwapPoint } from "./swapCandles.js";

const NOW = 1_788_788_000_000;
const MINUTE = 60_000;
const POOL: EvmPoolRef = {
  kind: "v3",
  pair: "0x7a6a053eccf1446a2633e05aa6d40d09381997ec",
  ledgerPair: "0x7a6a053ECCf1446A2633e05Aa6d40d09381997EC",
  logAddress: "0x7a6a053eccf1446a2633e05aa6d40d09381997ec",
  dex: "uniswap",
  token: "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e",
  quote: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  tokenIsCurrency0: false,
  tokenDecimals: 18,
  quoteDecimals: 6,
  fee: 3000
};
const ROW: PairRow = {
  chain: "robinhood",
  dex: "uniswap",
  pairAddress: POOL.ledgerPair,
  baseMint: POOL.token,
  quoteMint: POOL.quote,
  liquidityUsd: 4_550_000,
  volume24Usd: 1_000_000,
  share24: 1,
  txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
  tier: "A",
  sources: ["dexscreener"]
};

function point(minutesAgo: number, price: number, tx = `0x${minutesAgo}`): TimedSwapPoint {
  return { block: 1_000_000 - minutesAgo * 600, logIndex: 0, tx, side: "buy", price, quoteUnits: 100, tokenUnits: 100 / price, time: NOW - minutesAgo * MINUTE };
}

function print(minutesAgo: number, price: number | undefined, tx: string, source: FlowPrint["source"] = "own"): FlowPrint {
  return { chain: "robinhood", pair: POOL.ledgerPair, tx, time: NOW - minutesAgo * MINUTE, side: "sell", usd: price === undefined ? null : 50, source, ...(price === undefined ? {} : { price }) };
}
/** The 1m request asks for 24,216,000 ms (the block cap); a fill this deep has passed MIN_FILL_SHARE. */
const DEEP_ENOUGH_MS = 24_216_000 * MIN_FILL_SHARE;

function state(points: TimedSwapPoint[], overrides: Partial<PoolCandleState> = {}): PoolCandleState {
  return {
    key: `${POOL.pair}:${POOL.token}`,
    pool: POOL,
    points,
    fromBlock: 990_000,
    fromTime: NOW - 20 * MINUTE,
    toBlock: 1_000_000,
    spanMs: 3_600_000,
    stoppedBy: "depth",
    backfilling: false,
    chunks: 2,
    anchors: 4,
    estimatedChunks: 0,
    error: null,
    updatedAt: NOW,
    toppedUpAt: NOW,
    trimmed: 0,
    ...overrides
  };
}

function deps(cacheState: PoolCandleState, overrides: Partial<ChainCandleDeps> = {}): ChainCandleDeps & { ensure: ReturnType<typeof vi.fn> } {
  const ensure = vi.fn(async () => cacheState);
  return {
    resolvePool: async () => POOL,
    resolveError: () => null,
    cache: { ensure } as unknown as SwapCandleCache,
    quoteUsd: async () => 1,
    livePrints: () => [],
    now: () => NOW,
    ensure,
    ...overrides
  };
}

describe("livePrintsOutside", () => {
  it("keeps ring prints newer than the cached head and older than the fill's reach, never a tx the backfill carries, oldest first", () => {
    const cached = state([point(10, 400), point(2, 402, "0xshared")], { fromTime: NOW - 12 * MINUTE });
    const ring = [print(0, 405, "0xnew2"), print(1, 404, "0xnew1"), print(1.5, 403, "0xshared"), print(3, 399, "0xinside"), print(11, 398, "0xgap"), print(30, 390, "0xdeep")];
    expect(livePrintsOutside(ring, cached).map((p) => p.tx)).toEqual(["0xdeep", "0xnew1", "0xnew2"]);
    // without fromTime the oldest swap bounds the covered range
    expect(livePrintsOutside(ring, { ...cached, fromTime: null }).map((p) => p.tx)).toEqual(["0xdeep", "0xgap", "0xnew1", "0xnew2"]);
    expect(livePrintsOutside(ring, state([])).map((p) => p.tx)).toEqual(["0xdeep", "0xgap", "0xinside", "0xshared", "0xnew1", "0xnew2"]);
  });
});

describe("chainCandlesFor", () => {
  it("builds one 'chain swaps' series from cached swaps x quote USD plus live prints ticking the forming bar", async () => {
    const d = deps(state([point(10, 400), point(9.5, 401), point(2, 402)], { fromTime: NOW - 11 * MINUTE }), { quoteUsd: async () => 1, livePrints: () => [print(0.2, 405, "0xlive"), print(5, 380, "0xinside")] });
    const result = await chainCandlesFor(ROW, "5m", d);
    expect(d.ensure).toHaveBeenCalledWith(POOL, 2_000 * 5 * MINUTE > 24_216_000 ? 24_216_000 : 2_000 * 5 * MINUTE, undefined);
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]).toMatchObject({ open: 400, high: 401, low: 400, close: 401, volume: 200 });
    // the 402 swap and the 405 live print share the newest 5m bucket only if aligned; check the last bar closes on the live print
    expect(result.candles[result.candles.length - 1].close).toBe(405);
    expect(result.candleSource).toMatchObject({ kind: "chain swaps", backfilledFrom: { block: 990_000, time: NOW - 11 * MINUTE }, timing: CHAIN_TIMING, quoteUsd: 1, live: 1 });
    expect(result.candleSource.coverage).toMatchObject({ bars: 2, prints: 3, complete: true, backfilling: false });
    expect(result.notes[0]).toMatch(/candles from v3 Swap logs .*3 swaps, 2 chunks, 4 block anchors; times interpolated/);
    expect(result.notes).toContain("1 own-tape print(s) merged outside the backfilled range (forming bar; older ring prints until the fill reaches them; execution price, not pool price)");

    const halfway = state([point(2, 402)], { fromTime: NOW - DEEP_ENOUGH_MS, backfilling: true, stoppedBy: null });
    const early = await chainCandlesFor(ROW, "1m", deps(halfway, { livePrints: () => [print(0.5, 403, "0xlive"), print(2.5, 401, "0xinside"), print(20, 380, "0xring")] }));
    expect(early.candles.map((c) => c.close)).toEqual([402, 403]);
    expect(early.candleSource.live).toBe(1);
    expect(early.stale).toBe(false);
  });

  it("merges only own-tape prints: GeckoTerminal trade prints sharing the ring never enter the chain-swaps series", async () => {
    const ring = [print(0.2, 999, "0xgecko", "geckoterminal"), print(0.3, 405, "0xown"), print(0.4, 777, "0xpump", "pumpfun")];
    expect(ownPrints(ring).map((p) => p.tx)).toEqual(["0xown"]);
    const result = await chainCandlesFor(ROW, "5m", deps(state([point(10, 400)]), { livePrints: () => ring }));
    expect(result.candleSource.live).toBe(1);
    expect(result.candles.map((c) => c.high)).toEqual([400, 405]);
    expect(result.notes).toContain("1 own-tape print(s) merged outside the backfilled range (forming bar; older ring prints until the fill reaches them; execution price, not pool price)");
    // a complete fill with no swaps and only Gecko prints in the ring has nothing honest to chart as chain swaps
    await expect(chainCandlesFor(ROW, "5m", deps(state([]), { livePrints: () => [ring[0]] }))).rejects.toThrow(/found no swaps in range/);
  });

  it("scales prices and volume by the quote's current USD price and says so", async () => {
    const d = deps(state([point(3, 0.00002)]), { quoteUsd: async () => 1150 });
    const result = await chainCandlesFor(ROW, "1m", d);
    expect(result.candles[0].close).toBeCloseTo(0.023, 6);
    expect(result.candles[0].volume).toBe(115_000);
    expect(result.notes).toContain(`USD via current ${POOL.quote} price 1150 (DexScreener), not a historical quote series`);
  });

  it("hands a first fill shallower than MIN_FILL_SHARE back to the Gecko fallback instead of collapsing the chart to a few bars", async () => {
    const inFlight = deps(state([], { backfilling: true, fromBlock: null, fromTime: null, toBlock: null, stoppedBy: null, chunks: 0, anchors: 0 }));
    await expect(chainCandlesFor(ROW, "1m", inFlight)).rejects.toThrow(/chain backfill in progress: 0 of 404 min fetched \(0 swaps so far\)/);
    const shallow = state([point(2, 402), point(1, 403), point(0.5, 404)], { fromTime: NOW - 3 * MINUTE, backfilling: true, stoppedBy: null });
    await expect(chainCandlesFor(ROW, "1m", deps(shallow, { livePrints: () => [print(0.1, 405, "0xlive")] }))).rejects.toThrow(/in progress: 3 of 404 min fetched \(3 swaps so far\)/);
    // a deepening run after an earlier stop is not a first fill: its bars stay on screen while it runs
    const deepening = await chainCandlesFor(ROW, "1m", deps(state([point(2, 402)], { fromTime: NOW - 3 * MINUTE, backfilling: true, stoppedBy: "depth" })));
    expect(deepening.candles).toHaveLength(1);
    expect(deepening.candleSource.coverage).toMatchObject({ complete: false, backfilling: true });
    expect(deepening.notes).toContain("backfill in progress: older bars arrive on the next read");
  });

  it("annotates a capped, partially failed or extrapolated fill without hiding the bars it has", async () => {
    const result = await chainCandlesFor(ROW, "1m", deps(state([point(1, 400)], { stoppedBy: "cap", error: "upstream returned 429", estimatedChunks: 1, trimmed: 5 })));
    expect(result.candles).toHaveLength(1);
    // a recorded error means the head is not vouched current: not complete, and the response is stale
    expect(result.candleSource.coverage.complete).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/capped at 240,000 blocks/),
      expect.stringMatching(/chain backfill error: upstream returned 429 \(series may be partial; head not current\)/),
      expect.stringMatching(/1 chunk\(s\) lacked a readable block anchor/),
      expect.stringMatching(/5 oldest swaps dropped/)
    ]));
  });

  it("names the price basis: post-swap pool price for v3/v4, per-swap execution price for v2", async () => {
    const v3 = await chainCandlesFor(ROW, "1m", deps(state([point(1, 400)])));
    expect(v3.notes[0]).toMatch(/post-swap pool price \(sqrtPriceX96\)/);
    const v2 = await chainCandlesFor(ROW, "1m", deps(state([point(1, 400)]), { resolvePool: async () => ({ ...POOL, kind: "v2" }) }));
    expect(v2.notes[0]).toMatch(/candles from v2 Swap logs .*per-swap execution price \(quote units \/ token units; v2 logs carry no pool price\)/);
  });

  it("throws (so the caller can fall back to Gecko) on an unresolved pool, an unpriced quote, a failed fill, no swaps at all or a bad interval", async () => {
    await expect(chainCandlesFor(ROW, "1m", deps(state([]), { resolvePool: async () => null, resolveError: () => "pool tokens do not match" }))).rejects.toThrow(/unresolved: pool tokens do not match/);
    await expect(chainCandlesFor(ROW, "1m", deps(state([]), { quoteUsd: async () => null }))).rejects.toThrow(/has no USD price/);
    await expect(chainCandlesFor(ROW, "1m", deps(state([], { error: "log query timed out", stoppedBy: "error" })))).rejects.toThrow(/chain backfill failed: log query timed out/);
    await expect(chainCandlesFor(ROW, "1m", deps(state([])))).rejects.toThrow(/found no swaps in range/);
    await expect(chainCandlesFor(ROW, "1m", deps(state([], { backfilling: true, stoppedBy: "depth" })))).rejects.toThrow(/found no swaps yet \(still running\)/);
    await expect(chainCandlesFor(ROW, "2m", deps(state([])))).rejects.toThrow(/unsupported interval/);
  });
});
