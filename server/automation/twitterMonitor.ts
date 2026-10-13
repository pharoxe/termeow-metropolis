import { config } from "../config.js";
import type { AutomationRecord } from "../../shared/automation.js";
import { automationRepository } from "./runtime.js";
import { currentMarketCap, dispatchAutomationSignal } from "./dispatch.js";

type Tweet = { id?: string; text?: string; url?: string; createdAt?: string };
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;

/** Distinct 0x contract addresses mentioned in a post, lowercase (Monad is EVM, so nothing else is a contract). */
export function contractAddresses(text: string, _chain: "monad" = "monad") {
  return [...new Set((text.match(EVM_ADDRESS) ?? []).map((value) => value.toLowerCase()))];
}

async function latestTweets(handle: string, apiKey: string): Promise<Tweet[]> {
  const url = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
  url.searchParams.set("userName", handle);
  url.searchParams.set("includeReplies", "false");
  const response = await fetch(url, { headers: { "x-api-key": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`twitterapi.io ${response.status}`);
  const body = await response.json() as { tweets?: Tweet[] };
  return body.tweets ?? [];
}

async function inspectRule(rule: AutomationRecord, tweets: Tweet[]) {
  const handle = rule.intent.trackedXAccount?.replace(/^@/, "");
  if (!handle) return;
  for (const tweet of tweets) {
    const eventId = String(tweet.id || "");
    const createdAt = Date.parse(tweet.createdAt || "");
    if (!eventId || rule.lastSignal?.eventId === eventId || (Number.isFinite(createdAt) && createdAt < rule.createdAt)) continue;
    const address = contractAddresses(String(tweet.text || ""), rule.intent.chain)[0];
    if (!address) continue;
    const observedMarketCapUsd = await currentMarketCap(rule.intent.chain, address);
    const saved = await automationRepository.recordSignal(rule.id, { source: "x", eventId, tokenAddress: address, sourceUrl: tweet.url, observedAt: Date.now(), observedMarketCapUsd });
    if (saved) await dispatchAutomationSignal(rule.id, saved.lastSignal!).catch((error) => {
      console.error(`[automation] X signal dispatch failed for ${rule.id}:`, error instanceof Error ? error.message : error);
    });
    return;
  }
}

export function startTwitterLaunchMonitor() {
  const apiKey = config.twitterApi.apiKey;
  if (!apiKey) return () => undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rules = await automationRepository.armed("monitor_x_launch");
      const byHandle = new Map<string, AutomationRecord[]>();
      for (const rule of rules) {
        const handle = rule.intent.trackedXAccount?.replace(/^@/, "").toLowerCase();
        if (handle) byHandle.set(handle, [...(byHandle.get(handle) ?? []), rule]);
      }
      for (const [handle, handleRules] of byHandle) {
        const tweets = await latestTweets(handle, apiKey).catch(() => []);
        for (const rule of handleRules) await inspectRule(rule, tweets);
      }
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), config.twitterApi.pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
