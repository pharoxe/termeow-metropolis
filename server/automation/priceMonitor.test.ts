import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRecord } from "../../shared/automation.js";

const armed = vi.fn();
const recordSignal = vi.fn();
const dispatch = vi.fn();
vi.mock("./runtime.js", () => ({ automationRepository: { armed, recordSignal } }));
vi.mock("./dispatch.js", () => ({ dispatchAutomationSignal: dispatch }));

const { checkPriceTriggers, crossed } = await import("./priceMonitor.js");

const NOW = 1_800_000_000_000;
const TOKEN = "0x1111111111111111111111111111111111111111";
const rule = (over: Partial<AutomationRecord["intent"]> = {}, createdAt = NOW - 60_000): AutomationRecord => ({
  id: `rule-${Math.random()}`, userId: "u", status: "armed", source: "elevenlabs_voice", createdAt, updatedAt: createdAt,
  intent: { kind: "conditional_swap", chain: "monad", tokenAddress: TOKEN, side: "buy", triggerPriceUsd: 2, triggerDirection: "above", durationHours: 24, description: "breakout", ...over }
});
const quotes = (priceUsd: number | null) => async () => new Map([[TOKEN, { priceUsd, marketCapUsd: 5_000_000 }]]);

beforeEach(() => {
  armed.mockReset(); recordSignal.mockReset(); dispatch.mockReset();
  recordSignal.mockImplementation(async (id: string, signal: unknown) => ({ id, lastSignal: signal }));
  dispatch.mockResolvedValue(true);
});

describe("price-triggered swaps", () => {
  it("crosses above for breakouts and below for dip buys", () => {
    expect(crossed(rule().intent, 2)).toBe(true);
    expect(crossed(rule().intent, 1.99)).toBe(false);
    expect(crossed(rule({ triggerDirection: "below" }).intent, 1.5)).toBe(true);
    expect(crossed(rule({ triggerDirection: "below" }).intent, 2.5)).toBe(false);
  });

  it("records and dispatches a crossed rule with a fixed event id and the observed price and market cap", async () => {
    armed.mockResolvedValue([rule()]);
    expect(await checkPriceTriggers(NOW, quotes(2.1))).toBe(1);
    expect(recordSignal).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ source: "price", eventId: "price:above:2", tokenAddress: TOKEN, entryReferencePriceUsd: 2.1, observedMarketCapUsd: 5_000_000 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves uncrossed, unpriced and expired rules alone", async () => {
    armed.mockResolvedValue([rule(), rule({}, NOW - 25 * 3_600_000)]);
    expect(await checkPriceTriggers(NOW, quotes(1.5))).toBe(0);
    expect(await checkPriceTriggers(NOW, quotes(null))).toBe(0);
    armed.mockResolvedValue([rule({}, NOW - 25 * 3_600_000)]);
    expect(await checkPriceTriggers(NOW, quotes(9))).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
