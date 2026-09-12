import { alertSink } from "../alerts/sink.js";
import type { TraderFill } from "../traders/walletStats.js";
import { automationRepository } from "./runtime.js";

function sameWallet(chain: "solana" | "robinhood", left: string, right: string) {
  return chain === "robinhood" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function observeTrackedWalletFill(fill: TraderFill) {
  if (fill.side !== "buy") return 0;
  let matched = 0;
  for (const rule of await automationRepository.armed("monitor_wallet")) {
    const wallet = rule.intent.trackedWallet;
    const expiresAt = rule.createdAt + (rule.intent.durationHours ?? 24) * 3_600_000;
    if (!wallet || rule.intent.chain !== fill.chain || fill.time < rule.createdAt || Date.now() > expiresAt || !sameWallet(fill.chain, wallet, fill.trader)) continue;
    const saved = await automationRepository.recordSignal(rule.id, {
      source: "wallet", eventId: `${fill.tx}:${fill.side}:${fill.token}`, tokenAddress: fill.token,
      observedAt: fill.time, entryReferencePriceUsd: fill.price ?? undefined
    });
    if (saved) matched += 1;
  }
  return matched;
}

export function startWalletAutomationMonitor() {
  return alertSink.subscribe((event) => { if (event.kind === "fill") void observeTrackedWalletFill(event.fill); });
}
