import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { AlertEngineStats, AlertRow, FomoCoverage } from "../../shared/wire.js";
import { AlertRing } from "../alerts/ring.js";
import { ALERTS_DEFAULT, ALERTS_MAX, alertsQuerySchema, buildAlertsResponse, type AlertsRouteDeps } from "./alerts.js";

const NOW = 1_800_000_000_000;
const COVERAGE: FomoCoverage = { watched: 600, population: 1517, label: "watching 600 of 1,517 FOMO wallets · 147 named" };
const STATS: AlertEngineStats = { seen: { fills: 9, launches: 2, graduations: 0 }, fired: { first_fomo_buy: 1, big_handle_entry: 1, graduation: 0 }, suppressed: { first_fomo_buy: 3, big_handle_entry: 4, graduation: 0 }, errors: 0, lastError: null };

function alert(id: string, observedAt: number, over: Partial<AlertRow> = {}): AlertRow {
  return {
    id,
    rule: "graduation",
    chain: "robinhood",
    time: observedAt - 5_000,
    observedAt,
    token: "0x85cbb08468de217650fe1f684f4961a88808ff93",
    symbol: null,
    coverage: COVERAGE,
    evidence: { launchpad: "pons", pool: null, launchTx: "0xlaunch", graduationTx: null, fomoFills: 2 },
    ...over
  } as AlertRow;
}

function deps(rows: AlertRow[], over: Partial<AlertsRouteDeps> = {}): AlertsRouteDeps {
  const ring = new AlertRing({ max: 50 });
  for (const row of rows) ring.push(row);
  return { engine: { list: (query) => ring.list(query), ring, stats: () => STATS }, coverage: () => COVERAGE, now: () => NOW, ...over };
}

describe("alertsQuerySchema", () => {
  it("defaults chain all / limit 200 and coerces since, rule and limit", () => {
    expect(alertsQuerySchema.parse({})).toEqual({ chain: "all", limit: ALERTS_DEFAULT });
    expect(alertsQuerySchema.parse({ chain: "robinhood", since: "1700000000000", rule: "first_fomo_buy", limit: "5" })).toEqual({ chain: "robinhood", since: 1_700_000_000_000, rule: "first_fomo_buy", limit: 5 });
  });

  it("rejects unknown chains, rules, negative since and limits past the cap", () => {
    expect(() => alertsQuerySchema.parse({ chain: "base" })).toThrow(ZodError);
    expect(() => alertsQuerySchema.parse({ rule: "moon" })).toThrow(ZodError);
    expect(() => alertsQuerySchema.parse({ since: "-1" })).toThrow(ZodError);
    expect(() => alertsQuerySchema.parse({ limit: String(ALERTS_MAX + 1) })).toThrow(ZodError);
  });
});

describe("buildAlertsResponse", () => {
  it("answers newest first with ring size, coverage, engine stats and the rule registry for the chain", () => {
    const response = buildAlertsResponse(alertsQuerySchema.parse({}), deps([alert("a", NOW - 30_000), alert("b", NOW - 10_000)]));
    expect(response.alerts.map((row) => row.id)).toEqual(["b", "a"]);
    expect(response).toMatchObject({ chain: "all", observedAt: NOW, ring: { size: 2, max: 50 }, coverage: COVERAGE, engine: STATS });
    expect(response.rules.map((rule) => rule.rule)).toEqual(["first_fomo_buy", "big_handle_entry", "graduation"]);
    expect(response.stale).toBeUndefined();
  });

  it("Solana is an honest empty list with an empty rule registry", () => {
    const response = buildAlertsResponse(alertsQuerySchema.parse({ chain: "solana" }), deps([alert("a", NOW - 1)]));
    expect(response.alerts).toEqual([]);
    expect(response.rules).toEqual([]);
    expect(response.error).toBeUndefined();
  });

  it("since / rule / limit reach the engine query", () => {
    const rows = [alert("a", NOW - 30_000), alert("b", NOW - 10_000, { rule: "first_fomo_buy" } as Partial<AlertRow>), alert("c", NOW - 1)];
    expect(buildAlertsResponse(alertsQuerySchema.parse({ since: String(NOW - 10_000) }), deps(rows)).alerts.map((row) => row.id)).toEqual(["c"]);
    expect(buildAlertsResponse(alertsQuerySchema.parse({ rule: "first_fomo_buy" }), deps(rows)).alerts.map((row) => row.id)).toEqual(["b"]);
    expect(buildAlertsResponse(alertsQuerySchema.parse({ limit: "2" }), deps(rows)).alerts.map((row) => row.id)).toEqual(["c", "b"]);
  });

  it("a throwing engine keeps the 200 shape: empty list, zero ring, empty coverage, null engine, stale + error", () => {
    const broken = deps([], {
      engine: {
        list: () => {
          throw new Error("ring gone");
        },
        ring: new AlertRing(),
        stats: () => STATS
      }
    });
    const response = buildAlertsResponse(alertsQuerySchema.parse({}), broken);
    expect(response).toMatchObject({ alerts: [], ring: { size: 0, max: 0 }, engine: null, stale: true, error: "alerts: ring gone" });
    expect(response.coverage).toEqual({ watched: 0, population: 0, label: "watching 0 of 0 FOMO wallets · 0 named" });
  });
});
