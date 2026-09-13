import type { UserAutomationPreferences } from "../../shared/automation";

export const AGENT_GREETINGS = [
  "What are we aping today?",
  "Are we ready to print some cash?",
  "What’s moving in the trenches?",
  "Which setup are we hunting?",
  "What’s on your radar today?"
] as const;

export const pickAgentGreeting = () => AGENT_GREETINGS[Math.floor(Math.random() * AGENT_GREETINGS.length)];

const compactHandle = (value: string) => `@${value.replace(/^@/, "")}`;

/** Render private structured profile data for one authenticated conversation only. */
export function agentMemoryText(preferences?: UserAutomationPreferences) {
  if (!preferences) return "No saved trading preferences yet. Ask before assuming sizing, watched traders, or favorite tokens.";
  const favorites = (preferences.favoriteTraders || []).slice(0, 10).map((item) => compactHandle(item.handle));
  const learned = (preferences.trackedTraders || []).slice(0, 8).map((item) => compactHandle(item.handle));
  const tokens = (preferences.favoriteTokens || []).slice(0, 12).map((item) => `$${item.symbol.replace(/^\$+/, "").toUpperCase()}`);
  const lines = [
    favorites.length ? `Favorite traders: ${favorites.join(", ")}.` : "No favorite traders saved.",
    learned.length ? `Frequently tracked traders: ${learned.join(", ")}.` : "No learned wallet-tracking history yet.",
    tokens.length ? `Regular tokens: ${tokens.join(", ")}.` : "No regular tokens saved.",
    preferences.defaultAllocationPercent != null ? `Default trade size: ${preferences.defaultAllocationPercent}% of the relevant wallet.` : "No default trade size saved.",
    preferences.defaultSlippageBps != null ? `Default maximum slippage: ${preferences.defaultSlippageBps} bps.` : "No default slippage saved.",
    preferences.defaultDurationHours != null ? `Default automation duration: ${preferences.defaultDurationHours} hours.` : "No default automation duration saved.",
    preferences.lastTrade ? `Last completed trade: ${preferences.lastTrade.side.toUpperCase()} ${preferences.lastTrade.symbol ? `$${preferences.lastTrade.symbol}` : "a token"} on ${preferences.lastTrade.chain}.` : "No completed trade is recorded yet."
  ];
  return lines.join(" ");
}
