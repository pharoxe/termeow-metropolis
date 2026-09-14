export const CREDITS_PER_DOLLAR = 100;
export const INTRO_CREDITS = 500;
export const VOICE_CREDITS_PER_MINUTE = 40;
export const MAX_VOICE_SECONDS = 600;
export const VOICE_RESERVE_CREDITS = VOICE_CREDITS_PER_MINUTE * MAX_VOICE_SECONDS / 60;

/** One credit is one retail cent; provider cost is always marked up at least 2x. */
export function voiceChargeCredits(durationSeconds: number, providerCostUsd: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || !Number.isFinite(providerCostUsd) || providerCostUsd < 0)
    throw new Error("Invalid ElevenLabs usage metadata");
  return Math.max(1, Math.ceil(durationSeconds * VOICE_CREDITS_PER_MINUTE / 60), Math.ceil(providerCostUsd * 2 * CREDITS_PER_DOLLAR));
}

export function quoteBaseUnits(usd: number, priceUsd: number, decimals: number) {
  if (!Number.isInteger(usd) || usd <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Invalid payment quote");
  const precision = Math.min(decimals, 9);
  return BigInt(Math.ceil((usd / priceUsd) * 10 ** precision)) * 10n ** BigInt(decimals - precision);
}
