import { describe, expect, it } from "vitest";
import { config } from "../config.js";
import { MAX_AUTOMATION_VALUE_WEI, inspectAutomationTransaction } from "./privyExecutor.js";
import { MONAD_AUTOMATION_CONTRACT_ALLOWLIST } from "./privyPolicy.js";

const allowed = MONAD_AUTOMATION_CONTRACT_ALLOWLIST[0];
const stranger = "0x1111111111111111111111111111111111111111";
const tx = (patch: Partial<{ to: string; data: string; value: string; chainId: number }> = {}) =>
  ({ to: allowed, data: "0x", value: "0", chainId: config.network.chainId, ...patch });
const approve = (spender: string) => `0x095ea7b3${"0".repeat(24)}${spender.slice(2)}${"f".repeat(64)}`;

describe("Privy automation transaction inspection", () => {
  it("accepts a swap to an allowlisted Kuru Flow contract", () => {
    expect(inspectAutomationTransaction(tx())).toEqual({ kind: "swap", to: allowed.toLowerCase() });
  });

  it("accepts an ERC-20 approve whose spender is allowlisted", () => {
    expect(inspectAutomationTransaction(tx({ to: stranger, data: approve(allowed) }))).toMatchObject({ kind: "approve", spender: allowed.toLowerCase() });
  });

  it("rejects unapproved targets, spenders, chains and oversized value", () => {
    expect(() => inspectAutomationTransaction(tx({ to: stranger }))).toThrow(/unapproved contract/i);
    expect(() => inspectAutomationTransaction(tx({ to: stranger, data: approve(stranger) }))).toThrow(/unapproved spender/i);
    expect(() => inspectAutomationTransaction(tx({ chainId: 1 }))).toThrow(/not Monad/);
    expect(() => inspectAutomationTransaction(tx({ value: String(MAX_AUTOMATION_VALUE_WEI + 1n) }))).toThrow(/value/);
  });
});
