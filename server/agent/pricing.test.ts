import { describe, expect, it } from "vitest";
import { quoteBaseUnits, voiceChargeCredits, VOICE_RESERVE_CREDITS } from "./pricing.js";

describe("agent credit pricing", () => {
  it("starts with a refundable $4 hold for the current ten-minute call limit", () => {
    expect(VOICE_RESERVE_CREDITS).toBe(400);
  });
  it("charges at least 40 credits per minute and at least twice actual provider cost", () => {
    expect(voiceChargeCredits(60, 0.14)).toBe(40);
    expect(voiceChargeCredits(60, 0.25)).toBe(50);
    expect(voiceChargeCredits(0, 0)).toBe(1);
  });
  it("quotes precise stablecoin units and rounds native assets upward", () => {
    expect(quoteBaseUnits(10, 1, 6)).toBe(10_000_000n);
    expect(quoteBaseUnits(5, 100, 9)).toBe(50_000_000n);
    expect(quoteBaseUnits(10, 2500, 18)).toBe(4_000_000_000_000_000n);
  });
});
