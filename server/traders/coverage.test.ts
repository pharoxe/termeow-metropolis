import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCoverage, emptyCoverage } from "./coverage.js";

type Status = { status: { population: { classified: number; seeded: number }; handles: { entries: number }; transfers: { wallets: number; overflow: number } } };
/** Live /api/fomo/status captured 2026-09-07 12:30:53Z: legs pinned at 600 watched; transfers.wallets + overflow = 1,399 = the watch list (verified FOMO plus seeded wallets still pending), NOT the classified count. */
const T0 = JSON.parse(readFileSync(new URL("./__fixtures__/r5/status-t0.json", import.meta.url), "utf8")) as Status;

describe("coverage", () => {
  it("labels the r5 status-t0 capture as watching 600 of 1,399 wallets, naming the seeded-pending share (thousands separators, middle dot)", () => {
    const population = T0.status.transfers.wallets + T0.status.transfers.overflow;
    const seeded = T0.status.population.seeded;
    const built = buildCoverage({ watched: T0.status.transfers.wallets, population, seeded, named: T0.status.handles.entries });
    expect(population).toBe(1_399);
    expect(seeded).toBe(147);
    expect(built).toEqual({ watched: 600, population, label: `watching 600 of 1,399 wallets · 1,252 FOMO · 147 seeded pending · ${T0.status.handles.entries} named` });
  });

  it("matches the spec wording exactly for the 1,200 of 1,377 example when every wallet is verified FOMO", () => {
    expect(buildCoverage({ watched: 1_200, population: 1_377, seeded: 0, named: 147 }).label).toBe("watching 1,200 of 1,377 FOMO wallets · 147 named");
  });

  it("never reads watched or seeded above population and never emits NaN or negatives", () => {
    expect(buildCoverage({ watched: 900, population: 600, seeded: 0, named: 3 })).toMatchObject({ watched: 600, population: 600 });
    expect(buildCoverage({ watched: 1, population: 2, seeded: 9, named: 0 }).label).toBe("watching 1 of 2 wallets · 0 FOMO · 2 seeded pending · 0 named");
    expect(buildCoverage({ watched: Number.NaN, population: -4, seeded: -1, named: Number.POSITIVE_INFINITY })).toEqual({ watched: 0, population: 0, label: "watching 0 of 0 FOMO wallets · 0 named" });
  });

  it("gives failure branches the same shape with zeros", () => {
    expect(emptyCoverage()).toEqual({ watched: 0, population: 0, label: "watching 0 of 0 FOMO wallets · 0 named" });
  });
});
