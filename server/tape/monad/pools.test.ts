import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairRow } from "../../../shared/wire.js";
import { NATIVE_MON, POOL_MANAGER, poolResolveStatus, resetPoolCaches, resolvePoolRef, SELECTORS } from "./pools.js";

const RPC = "https://rpc.example.test/";
const FIXTURES = new URL("./__fixtures__/", import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

type PoolFixture = { pool: string; calls: Record<string, string | null> };
const V3_POOL = fixture("pool-0x353f2bd3.json") as PoolFixture;
const V2_POOL = fixture("pool-0x7ba7d2a2.json") as PoolFixture;

const FATCOIN = "0x12D5ee7917cA430073C3A638ee1e6f0648A98a01";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_PAIR = "0x353F2BD390D8db7BFC9B3dD389F8B71e8DF524fa";
const V2_PAIR = "0x7bA7D2A2D549BbB699fEAD825298b87fEa9f0a31";
const V4_PAIR = "0x70b5b746dc36c648893dafdf4b98d708a07673dfc1b3a0bb9dd70e36c0569f68";
const WORD_18 = "0x0000000000000000000000000000000000000000000000000000000000000012";
const WORD_6 = "0x0000000000000000000000000000000000000000000000000000000000000006";
const REVERT = { code: 3, message: "execution reverted" };

function row(overrides: Partial<PairRow>): PairRow {
  return {
    chain: "monad",
    dex: "uniswap",
    pairAddress: V4_PAIR,
    baseMint: FATCOIN,
    quoteMint: NATIVE_MON,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier: "A",
    sources: ["dexscreener"],
    ...overrides
  };
}

type Answer = { result?: string } | { error: unknown } | { status: number };
type Calls = Array<{ to: string; data: string }>;

/** eth_call stub answering by `${to}:${selector}` (lowercase); unknown calls revert like a real node. */
function fakeRpc(answers: Record<string, Answer>) {
  const calls: Calls = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: [{ to: string; data: string }, string] };
    const { to, data } = body.params[0];
    calls.push({ to, data });
    const answer = answers[`${to.toLowerCase()}:${data}`] ?? { error: REVERT };
    if ("status" in answer) return new Response("", { status: answer.status });
    const payload = "error" in answer ? { jsonrpc: "2.0", id: 1, error: answer.error } : { jsonrpc: "2.0", id: 1, result: answer.result };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function poolAnswers(pool: PoolFixture, token0: string, token1: string, dec0: string, dec1: string): Record<string, Answer> {
  const fee: Answer = pool.calls.fee === null ? { error: REVERT } : { result: pool.calls.fee };
  return {
    [`${pool.pool}:${SELECTORS.token0}`]: { result: pool.calls.token0 as string },
    [`${pool.pool}:${SELECTORS.token1}`]: { result: pool.calls.token1 as string },
    [`${pool.pool}:${SELECTORS.fee}`]: fee,
    [`${token0.toLowerCase()}:${SELECTORS.decimals}`]: { result: dec0 },
    [`${token1.toLowerCase()}:${SELECTORS.decimals}`]: { result: dec1 }
  };
}

const V3_ANSWERS = poolAnswers(V3_POOL, FATCOIN, USDG, WORD_18, WORD_6);
const V2_ANSWERS = poolAnswers(V2_POOL, WETH, FATCOIN, WORD_18, WORD_18);

beforeEach(() => resetPoolCaches());
afterEach(() => {
  resetPoolCaches();
  vi.unstubAllGlobals();
});

describe("resolvePoolRef v3 / v2 pair contracts", () => {
  it("classifies a pool with fee() as v3 and reads token order and decimals from the chain", async () => {
    const rpc = fakeRpc(V3_ANSWERS);
    const ref = await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref).toEqual({
      kind: "v3",
      pair: V3_PAIR.toLowerCase(),
      ledgerPair: V3_PAIR,
      logAddress: V3_PAIR.toLowerCase(),
      dex: "uniswap",
      token: FATCOIN.toLowerCase(),
      quote: USDG.toLowerCase(),
      tokenIsCurrency0: true,
      tokenDecimals: 18,
      quoteDecimals: 6,
      fee: 3000
    });
    expect(poolResolveStatus().lastError).toBeNull();
    expect(rpc.calls.map((call) => call.data).sort()).toEqual([SELECTORS.token0, SELECTORS.decimals, SELECTORS.decimals, SELECTORS.token1, SELECTORS.fee].sort());
  });

  it("classifies a pool whose fee() reverts as v2 with fee null and the token on the token1 side", async () => {
    const rpc = fakeRpc(V2_ANSWERS);
    const ref = await resolvePoolRef(row({ pairAddress: V2_PAIR, quoteMint: WETH }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref).toMatchObject({ kind: "v2", pair: V2_PAIR.toLowerCase(), ledgerPair: V2_PAIR, tokenIsCurrency0: false, fee: null });
    expect(ref?.tokenDecimals).toBe(18);
    expect(ref?.quoteDecimals).toBe(18);
    expect(ref?.quote).toBe(WETH.toLowerCase());
  });

  it("treats an empty 0x fee() return as v2 too", async () => {
    const rpc = fakeRpc({ ...V2_ANSWERS, [`${V2_POOL.pool}:${SELECTORS.fee}`]: { result: "0x" } });
    const ref = await resolvePoolRef(row({ pairAddress: V2_PAIR, quoteMint: WETH }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref?.kind).toBe("v2");
  });

  it("keeps ledgerPair in the registry's checksum casing while pair and logAddress are lowercase", async () => {
    const rpc = fakeRpc(V3_ANSWERS);
    const ref = await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref?.ledgerPair).toBe("0x353F2BD390D8db7BFC9B3dD389F8B71e8DF524fa");
    expect(ref?.pair).toBe("0x353f2bd390d8db7bfc9b3dd389f8b71e8df524fa");
  });

  it("returns null when token0/token1 do not match the row's base/quote", async () => {
    const rpc = fakeRpc(V3_ANSWERS);
    const ref = await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: WETH }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref).toBeNull();
    expect(poolResolveStatus().lastError).toContain("do not match");
  });

  it("returns null when fee() fails with a non-revert rpc error (cannot tell v2 from v3)", async () => {
    const rpc = fakeRpc({ ...V3_ANSWERS, [`${V3_POOL.pool}:${SELECTORS.fee}`]: { error: { code: -32005, message: "limit exceeded" } } });
    const ref = await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref).toBeNull();
    expect(poolResolveStatus().lastError).toBe(`${V3_PAIR}: eth_call: limit exceeded`);
  });

  it("returns null on HTTP failure and on a token0() revert", async () => {
    const http = fakeRpc({ ...V3_ANSWERS, [`${V3_POOL.pool}:${SELECTORS.token0}`]: { status: 502 } });
    expect(await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: http.fetchImpl })).toBeNull();
    expect(poolResolveStatus().lastError).toBe(`${V3_PAIR}: eth_call: upstream returned 502`);
    const revert = fakeRpc({ ...V3_ANSWERS, [`${V3_POOL.pool}:${SELECTORS.token0}`]: { error: REVERT } });
    expect(await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: revert.fetchImpl })).toBeNull();
    expect(poolResolveStatus().lastError).toBe(`${V3_PAIR}: eth_call: execution reverted`);
  });
});

describe("resolvePoolRef v4 poolIds", () => {
  it("puts native ETH (address 0) first, so FATCOIN is currency1, and never calls decimals() on ETH", async () => {
    const rpc = fakeRpc({ [`${FATCOIN.toLowerCase()}:${SELECTORS.decimals}`]: { result: WORD_18 } });
    const ref = await resolvePoolRef(row({}), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref).toEqual({
      kind: "v4",
      pair: V4_PAIR,
      ledgerPair: V4_PAIR,
      logAddress: POOL_MANAGER,
      dex: "uniswap",
      token: FATCOIN.toLowerCase(),
      quote: NATIVE_MON,
      tokenIsCurrency0: false,
      tokenDecimals: 18,
      quoteDecimals: 18,
      fee: null
    });
    expect(rpc.calls).toEqual([{ to: FATCOIN.toLowerCase(), data: SELECTORS.decimals }]);
  });

  it("orders by lowercase address the other way when the quote sorts after the token", async () => {
    const rpc = fakeRpc({
      [`${FATCOIN.toLowerCase()}:${SELECTORS.decimals}`]: { result: WORD_18 },
      [`${USDG.toLowerCase()}:${SELECTORS.decimals}`]: { result: WORD_6 }
    });
    const poolId = `0x${"ab".repeat(32)}`;
    const ref = await resolvePoolRef(row({ pairAddress: poolId, quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref).toMatchObject({ kind: "v4", pair: poolId, tokenIsCurrency0: true, tokenDecimals: 18, quoteDecimals: 6 });
  });

  it("does not depend on the casing DexScreener used for the poolId when matching, but keeps it for the ledger", async () => {
    const rpc = fakeRpc({ [`${FATCOIN.toLowerCase()}:${SELECTORS.decimals}`]: { result: WORD_18 } });
    const upper = V4_PAIR.toUpperCase().replace("0X", "0x");
    const ref = await resolvePoolRef(row({ pairAddress: upper }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref?.pair).toBe(V4_PAIR);
    expect(ref?.ledgerPair).toBe(upper);
  });
});

describe("resolvePoolRef caches and guards", () => {
  it("caches decimals per token address across pools", async () => {
    const rpc = fakeRpc({ ...V3_ANSWERS, ...V2_ANSWERS });
    await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    const before = rpc.calls.filter((call) => call.data === SELECTORS.decimals).length;
    expect(before).toBe(2);
    await resolvePoolRef(row({ pairAddress: V2_PAIR, quoteMint: WETH }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    const after = rpc.calls.filter((call) => call.data === SELECTORS.decimals);
    expect(after).toHaveLength(3);
    expect(after[2].to).toBe(WETH.toLowerCase());
    expect(poolResolveStatus().decimalsCached).toBe(3);
    resetPoolCaches();
    expect(poolResolveStatus()).toEqual({ lastError: null, decimalsCached: 0 });
  });

  it("returns null with lastError when the quote mint is missing, without touching the rpc", async () => {
    const rpc = fakeRpc(V3_ANSWERS);
    const ref = await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: null }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl });
    expect(ref).toBeNull();
    expect(rpc.calls).toHaveLength(0);
    expect(poolResolveStatus().lastError).toBe(`${V3_PAIR}: quote mint missing`);
  });

  it("returns null for a pair id that is neither 40-hex nor 64-hex, or a malformed token address", async () => {
    const rpc = fakeRpc(V3_ANSWERS);
    expect(await resolvePoolRef(row({ pairAddress: "pumpfun:abc", quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl })).toBeNull();
    expect(poolResolveStatus().lastError).toBe("pumpfun:abc: unrecognized pair id pumpfun:abc");
    expect(await resolvePoolRef(row({ pairAddress: V3_PAIR, baseMint: "So111", quoteMint: USDG }), { rpcUrl: RPC, fetchImpl: rpc.fetchImpl })).toBeNull();
    expect(poolResolveStatus().lastError).toContain("bad token addresses");
    expect(rpc.calls).toHaveLength(0);
  });

  it("uses the global fetch when no fetchImpl is given", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { to, data } = (JSON.parse(String(init?.body)) as { params: [{ to: string; data: string }] }).params[0];
      const answer = V3_ANSWERS[`${to.toLowerCase()}:${data}`];
      const payload = answer && "result" in answer ? { result: answer.result } : { error: REVERT };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ref = await resolvePoolRef(row({ pairAddress: V3_PAIR, quoteMint: USDG }), { rpcUrl: RPC });
    expect(ref?.kind).toBe("v3");
    expect(fetchMock).toHaveBeenCalled();
  });
});
