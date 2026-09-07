import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogsLane } from "./logsLane.js";

const START = 1_800_000_000_000;
const GAP = 5_000;

function makeLane(overrides: Partial<ConstructorParameters<typeof LogsLane>[0]> = {}) {
  const log = vi.fn();
  const lane = new LogsLane({ minGapMs: GAP, maxGapMs: 30_000, backfillGapMs: GAP, now: () => Date.now(), log, ...overrides });
  return { lane, log };
}

/** Runs `fn` on the lane and records when it started; `durationMs` of fake time passes inside the slot. */
function submit(lane: LogsLane, kind: "routine" | "priority", starts: Array<{ kind: string; at: number }>, durationMs = 0) {
  return lane.run(kind, async () => {
    starts.push({ kind, at: Date.now() });
    if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LogsLane cadence", () => {
  it("starts requests at least gapMs apart and never overlaps them, whoever asks", async () => {
    const { lane } = makeLane();
    const starts: Array<{ kind: string; at: number }> = [];
    void submit(lane, "routine", starts, 1_000);
    void submit(lane, "routine", starts, 1_000);
    void submit(lane, "routine", starts, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts.map((s) => s.at - START)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts.map((s) => s.at - START)).toEqual([0, GAP]);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(starts.map((s) => s.at - START)).toEqual([0, GAP, 2 * GAP]);
    expect(lane.stats()).toMatchObject({ served: { routine: 3, priority: 0 }, queued: { routine: 0, priority: 0 }, gapMs: GAP });
  });

  it("waits for a slow request to finish even past the gap: one in flight at a time", async () => {
    const { lane } = makeLane();
    const starts: Array<{ kind: string; at: number }> = [];
    void submit(lane, "routine", starts, 8_000);
    void submit(lane, "routine", starts);
    await vi.advanceTimersByTimeAsync(GAP + 1);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000 - GAP - 1);
    expect(starts.map((s) => s.at - START)).toEqual([0, 8_000]);
  });

  it("doubles the gap on every reported 429 up to maxGapMs and halves it back after a run of clean answers", async () => {
    const { lane, log } = makeLane({ recoverAfterOks: 3 });
    lane.report429();
    expect(lane.gapMs()).toBe(2 * GAP);
    expect(log).toHaveBeenCalledWith(`robinhood logs lane: 429, gap ${GAP} -> ${2 * GAP} ms`);
    lane.report429();
    lane.report429();
    expect(lane.gapMs()).toBe(30_000);
    lane.report429();
    expect(lane.gapMs()).toBe(30_000);
    lane.reportOk();
    lane.reportOk();
    expect(lane.gapMs()).toBe(30_000);
    lane.reportOk();
    expect(lane.gapMs()).toBe(15_000);
    for (let i = 0; i < 9; i += 1) lane.reportOk();
    expect(lane.gapMs()).toBe(GAP);
    expect(lane.stats().rateLimited).toBe(4);
  });

  it("applies a widened gap to the next slot and honours holdUntil from the pool", async () => {
    const { lane } = makeLane();
    const starts: Array<{ kind: string; at: number }> = [];
    void submit(lane, "routine", starts);
    await vi.advanceTimersByTimeAsync(0);
    lane.report429();
    void submit(lane, "routine", starts);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(starts.map((s) => s.at - START)).toEqual([0, 2 * GAP]);

    lane.holdUntil(Date.now() + 40_000);
    expect(lane.stats().holdUntil).toBe(Date.now() + 40_000);
    void submit(lane, "routine", starts);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(3);
    // a hold never shortens
    lane.holdUntil(Date.now() - 1);
    expect(lane.stats().holdUntil).toBeNull();
  });
});

describe("LogsLane priority", () => {
  it("gives a priority request the next free slot ahead of queued routine ticks and logs the jump", async () => {
    const { lane, log } = makeLane();
    const starts: Array<{ kind: string; at: number }> = [];
    void submit(lane, "routine", starts, 1_000);
    void submit(lane, "routine", starts);
    void submit(lane, "routine", starts);
    await vi.advanceTimersByTimeAsync(0);
    void submit(lane, "priority", starts);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(starts.map((s) => [s.kind, s.at - START])).toEqual([["routine", 0], ["priority", GAP]]);
    expect(log).toHaveBeenCalledWith("robinhood logs lane: priority backfill slot ahead of 2 queued tick(s)");
    expect(lane.stats().jumped).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * GAP);
    expect(starts.map((s) => s.kind)).toEqual(["routine", "priority", "routine", "routine"]);
  });

  it("bounds the jump to one priority slot per backfillGapMs while ticks wait, but never idles when nothing else waits", async () => {
    const { lane } = makeLane({ backfillGapMs: 12_000 });
    const starts: Array<{ kind: string; at: number }> = [];
    void submit(lane, "routine", starts);
    void submit(lane, "routine", starts);
    void submit(lane, "routine", starts);
    void submit(lane, "priority", starts);
    void submit(lane, "priority", starts);
    await vi.advanceTimersByTimeAsync(0);
    // t=0 routine (first in), t=5s priority (jump), t=10s routine (second priority not due until 12 s later), t=15s routine, t=20s priority
    await vi.advanceTimersByTimeAsync(4 * GAP);
    expect(starts.map((s) => [s.kind, s.at - START])).toEqual([
      ["routine", 0],
      ["priority", GAP],
      ["routine", 2 * GAP],
      ["routine", 3 * GAP],
      ["priority", 4 * GAP]
    ]);
    // an idle lane serves a lone priority request as soon as the gap allows, whatever backfillGapMs says
    void submit(lane, "priority", starts);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(starts.at(-1)).toEqual({ kind: "priority", at: START + 5 * GAP });
    expect(lane.stats().served).toEqual({ routine: 3, priority: 3 });
  });

  it("frees the slot when the request throws", async () => {
    const { lane } = makeLane();
    const starts: Array<{ kind: string; at: number }> = [];
    const failing = lane.run("routine", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    void submit(lane, "routine", starts);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(starts).toHaveLength(1);
  });
});
