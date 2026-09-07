import { describe, expect, it, vi } from "vitest";
import type { TokenBatch } from "../sources/dexscreenerTokens.js";
import { TRENCHES_SOURCE, type TrenchTokensResult } from "../sources/trenches.js";
import { ERC20_META_SOURCE, erc20MetaUpsert } from "./enrich.js";
import { LaunchIndex } from "./index.js";
import { LaunchService, NAME_BATCH, type Erc20MetaLike } from "./service.js";

const NOW = 1_800_000_000_000;
const PONS = "0xaaaa000000000000000000000000000000000001";
const PROFILE = "0xbbbb000000000000000000000000000000000002";
const NAMED = "0xcccc000000000000000000000000000000000003";
const MINT = "So11111111111111111111111111111111111111112";

const trenchResult = (): TrenchTokensResult => ({ rows: [], source: TRENCHES_SOURCE, window: "24h", observedAt: NOW, stale: false });

function service(erc20Meta: Erc20MetaLike) {
  const index = new LaunchIndex({ now: () => NOW });
  const robinhood = { start: vi.fn(), stop: vi.fn(), stats: vi.fn(() => ({ poller: { lastOkAt: NOW, lastError: null } }) as never) };
  const pump = { start: vi.fn(), stop: vi.fn(), status: vi.fn(() => ({ connected: true, launches: 0, reconnects: 0, framesSeen: 1, lastFrameAt: NOW, lastLaunchAt: null, lastError: null })) };
  const svc = new LaunchService({
    index,
    now: () => NOW,
    log: vi.fn(),
    robinhood: () => robinhood,
    pumpportal: () => pump,
    fetchProfiles: async () => [],
    fetchBoosts: async () => [],
    fetchTokenBatches: async () => new Map() as TokenBatch,
    fetchTrenchTokens: async () => trenchResult(),
    erc20Meta
  });
  return { svc, index };
}

describe("erc20MetaUpsert", () => {
  it("writes only the symbol with the erc20 source; name stays out because the contract read carries none", () => {
    expect(erc20MetaUpsert(PONS, { symbol: "MEAO" })).toEqual({ chain: "robinhood", token: PONS, symbol: "MEAO", sources: [ERC20_META_SOURCE] });
  });

  it("is null for an unresolved lookup or a contract with no readable symbol, so nothing is upserted", () => {
    expect(erc20MetaUpsert(PONS, null)).toBeNull();
    expect(erc20MetaUpsert(PONS, { symbol: null })).toBeNull();
  });
});

describe("LaunchService.enrichNames", () => {
  it("names Pons and profile rows from erc20Meta on refresh, leaves unresolved rows null, never asks named or Solana rows", async () => {
    const resolve = vi.fn(async (token: string) => (token === PONS ? { symbol: "MEAO", decimals: 18, resolvedAt: NOW } : null));
    const { svc, index } = service({ resolve });
    index.upsert({ chain: "robinhood", token: PONS, launchpad: "pons", createdAt: NOW - 1_000, sources: ["rpc:robinhood"] });
    index.upsert({ chain: "robinhood", token: PROFILE, launchpad: "dexscreener-profile", createdAt: NOW - 2_000, sources: ["dexscreener token-profiles"] });
    index.upsert({ chain: "robinhood", token: NAMED, launchpad: "flap", symbol: "FLP", createdAt: NOW - 3_000, sources: ["rpc:robinhood"] });
    index.upsert({ chain: "solana", token: MINT, launchpad: "pump.fun", createdAt: NOW - 500, sources: ["pumpportal"] });
    await svc.refresh();
    expect(resolve.mock.calls.map(([token]) => token)).toEqual([PONS, PROFILE]);
    expect(index.get("robinhood", PONS)).toMatchObject({ symbol: "MEAO", name: null, launchpad: "pons", sources: ["rpc:robinhood", ERC20_META_SOURCE] });
    expect(index.get("robinhood", PROFILE)).toMatchObject({ symbol: null, sources: ["dexscreener token-profiles"] });
    expect(index.get("robinhood", NAMED)?.sources).toEqual(["rpc:robinhood"]);
    expect(svc.status().sources.find((source) => source.name === ERC20_META_SOURCE)).toEqual({ name: ERC20_META_SOURCE, lastOkAt: NOW, lastError: null });
  });

  it("caps one round at NAME_BATCH newest unnamed rows", async () => {
    const resolve = vi.fn(async (_token: string) => null);
    const { svc, index } = service({ resolve });
    for (let i = 0; i < NAME_BATCH + 5; i += 1) index.upsert({ chain: "robinhood", token: `0x${String(i + 1).padStart(40, "0")}`, launchpad: "pons", createdAt: NOW - i * 1_000 });
    await svc.refresh();
    expect(resolve).toHaveBeenCalledTimes(NAME_BATCH);
    expect(resolve.mock.calls[0][0]).toBe(`0x${"1".padStart(40, "0")}`);
  });

  it("records a throwing lookup on the source health and keeps the rows unnamed", async () => {
    const { svc, index } = service({ resolve: async () => Promise.reject(new Error("eth_call: upstream returned 429")) });
    index.upsert({ chain: "robinhood", token: PONS, launchpad: "pons", createdAt: NOW - 1_000 });
    await svc.refresh();
    expect(index.get("robinhood", PONS)?.symbol).toBeNull();
    expect(svc.status().sources.find((source) => source.name === ERC20_META_SOURCE)).toEqual({ name: ERC20_META_SOURCE, lastOkAt: null, lastError: "eth_call: upstream returned 429" });
  });
});
