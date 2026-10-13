import { describe, expect, it } from "vitest";
import type { LaunchRow } from "../../shared/wire.js";
import type { TraderFill } from "../traders/walletStats.js";
import {
  ALERT_RULES,
  BIG_FOLLOWERS,
  CREATED_AT_SLACK_MS,
  LAUNCH_FRESH_MS,
  alertId,
  bigHandleEvidence,
  fillEvidence,
  firstSmartBuyEvidence,
  graduationEvidence,
  hasChainLaunchSource,
  isBigHandle,
  isSmartBuy,
  isFreshLaunch,
  rulesFor
} from "./rules.js";
import fixture from "./__fixtures__/launches-and-fills.json";

const [C4T, , FRESH36] = fixture.tokens;
const launch36 = FRESH36.launch as LaunchRow;
const buy36 = FRESH36.fills[0];

function fill(over: Partial<TraderFill> = {}): TraderFill {
  return { chain: "monad", pair: `smart:${buy36.token}`, tx: buy36.tx, time: buy36.time, side: "buy", usd: buy36.usd, source: "own", trader: buy36.trader.address, token: buy36.token, kind: "smart", handle: null, followers: null, usdVia: "hub_leg", ...over };
}

describe("launch freshness (chain time only)", () => {
  it("36 s after an rpc:monad launch is fresh; 30 min is not", () => {
    expect(isFreshLaunch(launch36, buy36.time)).toBe(true);
    expect(buy36.time - launch36.createdAt).toBe(35_891);
    expect(isFreshLaunch(launch36, launch36.createdAt + LAUNCH_FRESH_MS)).toBe(false);
    expect(isFreshLaunch(launch36, launch36.createdAt + LAUNCH_FRESH_MS - 1)).toBe(true);
  });

  it("tolerates the createdAt estimate error but not a fill from before the launch", () => {
    expect(isFreshLaunch(launch36, launch36.createdAt - CREATED_AT_SLACK_MS)).toBe(true);
    expect(isFreshLaunch(launch36, launch36.createdAt - CREATED_AT_SLACK_MS - 1)).toBe(false);
  });

  it("a row known only through enrichment is never fresh, whatever its createdAt", () => {
    const enriched: LaunchRow = { ...launch36, sources: ["dexscreener-profile"], launchpad: "unknown", createdAt: buy36.time - 1_000 };
    expect(hasChainLaunchSource(enriched.sources)).toBe(false);
    expect(isFreshLaunch(enriched, buy36.time)).toBe(false);
    expect(hasChainLaunchSource(undefined)).toBe(false);
    expect(hasChainLaunchSource(["pumpportal"])).toBe(true);
  });

  it("first_smart_buy evidence names launchpad, estimated createdAt, age, launch tx and the fill", () => {
    const evidence = firstSmartBuyEvidence(launch36, fill());
    expect(evidence).toMatchObject({ launchpad: "pons", createdAt: launch36.createdAt, createdAtEstimated: true, launchAgeMs: 35_891, launchTx: launch36.tx });
    expect(evidence.fill).toEqual({ tx: buy36.tx, wallet: buy36.trader.address, kind: "smart", handle: null, followers: null, side: "buy", usd: buy36.usd, usdVia: "hub_leg" });
  });
});

describe("SMART buy and big handle predicates", () => {
  it("only a verified-SMART buy counts; seeded, other, null and sells never", () => {
    expect(isSmartBuy(fill())).toBe(true);
    expect(isSmartBuy(fill({ side: "sell" }))).toBe(false);
    expect(isSmartBuy(fill({ kind: "seeded" }))).toBe(false);
    expect(isSmartBuy(fill({ kind: "other" }))).toBe(false);
    expect(isSmartBuy(fill({ kind: null }))).toBe(false);
  });

  it("big handle needs a handle, followers at the floor and a verified-SMART kind (seeded never: check pending)", () => {
    const dopamine = fixture.highFollowerFills[0];
    const base = fill({ handle: dopamine.trader.handle, followers: dopamine.trader.followers, side: "sell" });
    expect(isBigHandle(base)).toBe(true);
    expect(isBigHandle(fill({ handle: "x", followers: BIG_FOLLOWERS - 1 }))).toBe(false);
    expect(isBigHandle(fill({ handle: "x", followers: BIG_FOLLOWERS }))).toBe(true);
    expect(isBigHandle(fill({ handle: null, followers: 999_999 }))).toBe(false);
    expect(isBigHandle(fill({ handle: "x", followers: 999_999, kind: "other" }))).toBe(false);
    expect(isBigHandle(fill({ handle: "x", followers: 999_999, kind: null }))).toBe(false);
    expect(isBigHandle(fill({ handle: "unipcs", followers: 514_576, kind: "seeded", usd: null }))).toBe(false);
    if (isBigHandle(base)) expect(bigHandleEvidence(base, base.time - 60_000)).toMatchObject({ handle: dopamine.trader.handle, followers: dopamine.trader.followers, kind: "smart", bookSince: base.time - 60_000 });
  });

  it("fill evidence keeps usd null honest and omits usdVia when absent", () => {
    const unpriced = fillEvidence(fill({ usd: null, usdVia: undefined }));
    expect(unpriced.usd).toBeNull();
    expect("usdVia" in unpriced).toBe(false);
  });
});

describe("rule registry", () => {
  it("every rule applies to Monad", () => {
    expect(ALERT_RULES.map((rule) => rule.rule)).toEqual(["first_smart_buy", "big_handle_entry", "graduation"]);
    expect(rulesFor("monad")).toHaveLength(3);
    expect(rulesFor("all")).toHaveLength(3);
  });

  it("ids encode rule + chain + token (+ wallet for big handles)", () => {
    expect(alertId("first_smart_buy", "monad", C4T.token)).toBe(`first_smart_buy:monad:${C4T.token}`);
    expect(alertId("big_handle_entry", "monad", C4T.token, "0xabc")).toBe(`big_handle_entry:monad:${C4T.token}:0xabc`);
  });

  it("graduation evidence says the graduation tx is not carried by the index", () => {
    expect(graduationEvidence(launch36, 3)).toEqual({ launchpad: "pons", pool: null, launchTx: launch36.tx, graduationTx: null, smartFills: 3 });
  });
});
