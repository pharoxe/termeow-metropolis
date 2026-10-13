import { alertSink } from "../alerts/sink.js";
import { getTraderService } from "../traders/service.js";
import type { TraderFill } from "../traders/walletStats.js";
import { automationRepository } from "./runtime.js";
import { currentMarketCap, dispatchAutomationSignal } from "./dispatch.js";

function sameWallet(_chain: "monad", left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

export async function observeTrackedWalletFill(fill: TraderFill) {
  if (fill.side !== "buy") return 0;
  let matched = 0;
  for (const rule of await automationRepository.armed("monitor_wallet")) {
    const wallet = rule.intent.trackedWallet;
    const expiresAt = rule.createdAt + (rule.intent.durationHours ?? 24) * 3_600_000;
    if (!wallet || rule.intent.chain !== fill.chain || fill.time < rule.createdAt || Date.now() > expiresAt || !sameWallet(fill.chain, wallet, fill.trader)) continue;
    const observedMarketCapUsd = await currentMarketCap(rule.intent.chain, fill.token);
    const saved = await automationRepository.recordSignal(rule.id, {
      source: "wallet", eventId: `${fill.tx}:${fill.side}:${fill.token}`, tokenAddress: fill.token,
      observedAt: fill.time, entryReferencePriceUsd: fill.price ?? undefined, observedMarketCapUsd
    });
    if (saved) {
      matched += 1;
      await dispatchAutomationSignal(rule.id, saved.lastSignal!).catch((error) => {
        console.error(`[automation] wallet signal dispatch failed for ${rule.id}:`, error instanceof Error ? error.message : error);
      });
    }
  }
  return matched;
}

/** Every armed wallet monitor's wallet joins the trader service's watchlist so its fills reach the alert sink. */
export async function watchArmedWallets() {
  const rules = await automationRepository.armed("monitor_wallet");
  const wallets = rules.map((rule) => rule.intent.trackedWallet).filter((wallet): wallet is string => Boolean(wallet));
  if (wallets.length) getTraderService().watchWallets(wallets);
  return wallets.length;
}

export function startWalletAutomationMonitor() {
  const timer = setInterval(() => void watchArmedWallets().catch(() => undefined), 5 * 60_000);
  timer.unref?.();
  void watchArmedWallets().catch((error) => console.warn("[automation] watchlist restore deferred:", error instanceof Error ? error.message : error));
  const unsubscribe = alertSink.subscribe((event) => { if (event.kind === "fill") void observeTrackedWalletFill(event.fill); });
  return () => { clearInterval(timer); unsubscribe(); };
}
