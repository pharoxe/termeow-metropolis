import { describe, expect, it } from "vitest";
import { createBackoff } from "./backoff.js";
import { UpstreamError } from "./http.js";

describe("createBackoff", () => {
  it("blocks only after a 429 and only for blockMs", () => {
    let now = 1_000;
    const backoff = createBackoff("pump.fun", 20_000, () => now);
    expect(backoff.isBlocked()).toBe(false);
    backoff.noteError(new UpstreamError("Upstream returned 500", 500));
    backoff.noteError(new Error("socket hang up"));
    expect(backoff.isBlocked()).toBe(false);
    backoff.noteError(new UpstreamError("Upstream returned 429", 429));
    expect(backoff.isBlocked()).toBe(true);
    now += 19_999;
    expect(backoff.isBlocked()).toBe(true);
    now += 1;
    expect(backoff.isBlocked()).toBe(false);
  });

  it("reset lifts the block and blockedError carries the label and a 429 status", () => {
    const backoff = createBackoff("pump.fun", 20_000, () => 0);
    backoff.noteError(new UpstreamError("Upstream returned 429", 429));
    expect(backoff.isBlocked()).toBe(true);
    backoff.reset();
    expect(backoff.isBlocked()).toBe(false);
    expect(backoff.blockedError()).toMatchObject({ message: "pump.fun backoff active after 429", status: 429 });
  });
});
