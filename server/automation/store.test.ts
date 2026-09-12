import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "./store.js";

const dirs: string[] = [];
const makeStore = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "termeow-automation-"));
  dirs.push(directory);
  return { directory, store: new AutomationStore(directory) };
};
afterEach(() => dirs.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("AutomationStore", () => {
  it("isolates records by Privy user and requires approval before execution", () => {
    const { store } = makeStore();
    const draft = store.create("did:privy:alice", {
      kind: "swap", chain: "solana", tokenAddress: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
      side: "buy", router: "jupiter", amountMode: "wallet_percent", allocationPercent: 5, description: "Buy ANSEM with 5%"
    }, { source: "elevenlabs_voice", conversationId: "conversation-1" });
    expect(draft.status).toBe("pending_approval");
    expect(store.list("did:privy:bob")).toEqual([]);
    expect(store.report("did:privy:alice", draft.id, "executing")).toBeNull();
    expect(store.approve("did:privy:bob", draft.id)).toBeNull();
    const approved = store.approve("did:privy:alice", draft.id);
    expect(approved?.approvalMethod).toBe("privy_passkey_mfa");
    expect(store.report("did:privy:alice", draft.id, "completed", { transactionHash: "tx-1" })?.transactionHash).toBe("tx-1");
  });

  it("persists records across process restarts", () => {
    const { directory, store } = makeStore();
    const draft = store.create("did:privy:alice", {
      kind: "monitor_deployer", chain: "robinhood", tokenAddress: "0x1111111111111111111111111111111111111111",
      tokenSymbol: "ANSEM", tokenName: "The Black Bull", tokenLogoUrl: "https://assets.example/ansem.png",
      trackedWallet: "0x2222222222222222222222222222222222222222", trackedWalletUsername: "trenchking",
      router: "0x", amountMode: "wallet_percent", allocationPercent: 5, durationHours: 72,
      marketCapMinUsd: 1_000_000, marketCapMaxUsd: 5_000_000,
      condition: "Buy deployments funded by this deployer", description: "Monitor deployer for 3 days"
    });
    const restored = new AutomationStore(directory).get("did:privy:alice", draft.id)?.intent;
    expect(restored).toMatchObject({ durationHours: 72, tokenSymbol: "ANSEM", trackedWalletUsername: "trenchking", marketCapMinUsd: 1_000_000, marketCapMaxUsd: 5_000_000 });
  });

  it("edits only pending previews and remembers resolved trader preferences", () => {
    const { directory, store } = makeStore();
    const draft = store.create("did:privy:alice", {
      kind: "monitor_wallet", chain: "robinhood", trackedWallet: "0x2222222222222222222222222222222222222222",
      trackedWalletUsername: "FrankDeGods", side: "buy", router: "0x", amountMode: "wallet_percent",
      allocationPercent: 10, durationHours: 8, entryPriceTolerancePct: 25, slippageBps: 75,
      condition: "Buy any observed token within 25% of entry", description: "Track FrankDeGods buys"
    });
    const edited = store.updatePending("did:privy:alice", draft.id, { ...draft.intent, allocationPercent: 8, slippageBps: 50 });
    expect(edited?.intent).toMatchObject({ allocationPercent: 8, slippageBps: 50 });
    expect(store.userPreferences("did:privy:alice").trackedTraders[0]).toMatchObject({ handle: "frankdegods", uses: 2 });
    store.approve("did:privy:alice", draft.id);
    expect(store.updatePending("did:privy:alice", draft.id, draft.intent)).toBeNull();
    expect(new AutomationStore(directory).userPreferences("did:privy:alice").trackedTraders[0].handle).toBe("frankdegods");
  });

  it("activates linked exits only after a successful buy entry", () => {
    const { store } = makeStore();
    const intent = {
      kind: "swap" as const, chain: "solana" as const, tokenAddress: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
      side: "buy" as const, router: "jupiter" as const, amountMode: "wallet_percent" as const, allocationPercent: 5,
      description: "Buy then manage exit", exitConditions: [{ id: "tp", type: "take_profit_pct" as const, value: 25,
        condition: "Sell after a 25% gain", sellPercent: 100, activateAfter: "entry_confirmed" as const }]
    };
    const failed = store.create("did:privy:alice", intent);
    store.approve("did:privy:alice", failed.id);
    expect(store.report("did:privy:alice", failed.id, "failed", { failure: "reverted" })?.activeExitConditions).toBeUndefined();
    const completed = store.create("did:privy:alice", intent);
    store.approve("did:privy:alice", completed.id);
    expect(store.report("did:privy:alice", completed.id, "completed", { transactionHash: "tx" })?.activeExitConditions).toEqual(intent.exitConditions);
  });
});
