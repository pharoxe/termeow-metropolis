import type { AutomationRecord } from "../../shared/automation.js";
import { fetchTokenBatch } from "../sources/dexscreenerTokens.js";
import { automationRepository } from "./runtime.js";
import { dispatchAutomationSignal } from "./dispatch.js";

/** DexScreener's keyless token endpoint allows ~300 requests/min; one batched call per tick is far inside that. */
export const PRICE_POLL_MS = 15_000;

type Quote = { priceUsd: number | null; marketCapUsd: number | null };

export function crossed(intent: AutomationRecord["intent"], priceUsd: number) {
  const level = intent.triggerPriceUsd;
  if (!level) return false;
  return intent.triggerDirection === "below" ? priceUsd <= level : priceUsd >= level;
}

/**
 * One pass over armed price-triggered swaps: a rule whose token has crossed its level is recorded and handed to the
 * automation queue, which executes it through Kuru Flow on the user's delegated wallet. The event id is fixed per rule,
 * so claimExecution lets each rule fire at most once however many ticks see the cross.
 */
export async function checkPriceTriggers(now = Date.now(), quotes: (addresses: string[]) => Promise<Map<string, Quote>> = (addresses) => fetchTokenBatch("monad", addresses)) {
  const rules = (await automationRepository.armed("conditional_swap")).filter((rule) =>
    rule.intent.tokenAddress && rule.intent.triggerPriceUsd && now <= rule.createdAt + (rule.intent.durationHours ?? 24) * 3_600_000);
  if (!rules.length) return 0;
  const prices = await quotes([...new Set(rules.map((rule) => rule.intent.tokenAddress!.toLowerCase()))]);
  let fired = 0;
  for (const rule of rules) {
    const token = rule.intent.tokenAddress!.toLowerCase();
    const quote = prices.get(token);
    if (quote?.priceUsd == null || !crossed(rule.intent, quote.priceUsd)) continue;
    const saved = await automationRepository.recordSignal(rule.id, {
      source: "price", eventId: `price:${rule.intent.triggerDirection ?? "above"}:${rule.intent.triggerPriceUsd}`, tokenAddress: token,
      observedAt: now, entryReferencePriceUsd: quote.priceUsd, observedMarketCapUsd: quote.marketCapUsd ?? undefined
    });
    if (!saved?.lastSignal) continue;
    fired += 1;
    console.log(`[automation] ${rule.id} price ${quote.priceUsd} crossed ${rule.intent.triggerDirection ?? "above"} ${rule.intent.triggerPriceUsd}`);
    await dispatchAutomationSignal(rule.id, saved.lastSignal).catch((error) => {
      console.error(`[automation] price signal dispatch failed for ${rule.id}:`, error instanceof Error ? error.message : error);
    });
  }
  return fired;
}

export function startPriceAutomationMonitor() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await checkPriceTriggers(); }
    catch (error) { console.warn("[automation] price check failed:", error instanceof Error ? error.message : error); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), PRICE_POLL_MS);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
