import { describe, expect, it } from "vitest";
import type { LaunchRow } from "../../shared/wire.js";
import { AlertingLaunchIndex } from "./launchIndex.js";
import type { AlertSinkLike } from "./sink.js";
import fixture from "./__fixtures__/launches-and-fills.json";

const launch = fixture.tokens[2].launch as LaunchRow;

function recorder(): AlertSinkLike & { launches: LaunchRow[]; graduations: Array<{ token: string; at: number }> } {
  const launches: LaunchRow[] = [];
  const graduations: Array<{ token: string; at: number }> = [];
  return { launches, graduations, fill: () => undefined, launch: (row) => launches.push(row), graduation: (row, at) => graduations.push({ token: row.token, at }) };
}

describe("AlertingLaunchIndex", () => {
  it("fires launch once, when the row first carries a chain source, and behaves as a LaunchIndex otherwise", () => {
    const sink = recorder();
    const index = new AlertingLaunchIndex(sink, { now: () => launch.createdAt + 500 });
    const row = index.upsert({ chain: "robinhood", token: launch.token, launchpad: "pons", createdAt: launch.createdAt, tx: launch.tx, sources: ["rpc:robinhood"] });
    expect(row.launchpad).toBe("pons");
    expect(sink.launches).toHaveLength(1);
    index.upsert({ chain: "robinhood", token: launch.token, symbol: "LATE", sources: ["dexscreener-tokens"] });
    expect(sink.launches).toHaveLength(1);
    expect(index.get("robinhood", launch.token)?.symbol).toBe("LATE");
  });

  it("an enrichment-born row fires only when a chain source later confirms it; dexscreener-only rows never fire", () => {
    const sink = recorder();
    const index = new AlertingLaunchIndex(sink);
    index.upsert({ chain: "robinhood", token: launch.token, sources: ["dexscreener-profile"] });
    expect(sink.launches).toHaveLength(0);
    index.upsert({ chain: "robinhood", token: launch.token, launchpad: "pons", createdAt: launch.createdAt, sources: ["rpc:robinhood"] });
    expect(sink.launches).toHaveLength(1);
    expect(sink.launches[0].createdAt).toBe(launch.createdAt);
  });

  it("fires graduation per applied recordGraduation with the updated row and stays silent for unknown tokens", () => {
    const sink = recorder();
    const index = new AlertingLaunchIndex(sink);
    expect(index.recordGraduation("robinhood", launch.token, 5, null)).toBe(false);
    expect(sink.graduations).toEqual([]);
    index.upsert({ chain: "robinhood", token: launch.token, launchpad: "pons", createdAt: launch.createdAt, sources: ["rpc:robinhood"] });
    expect(index.recordGraduation("robinhood", launch.token, launch.createdAt + 60_000, null)).toBe(true);
    expect(sink.graduations).toEqual([{ token: launch.token, at: launch.createdAt + 60_000 }]);
    expect(index.get("robinhood", launch.token)?.graduatedAt).toBe(launch.createdAt + 60_000);
  });
});
