import type { SmartCoverage } from "../../shared/wire.js";

export type CoverageInput = {
  /** Wallets currently inside the transfer legs (TransferFeedStats.wallets). */
  watched: number;
  /** Wallets this server should be watching: classified SMART plus seeded not proven "other". */
  population: number;
  /** Of `population`, seeded wallets whose smart-money check is still pending (never counted as SMART). */
  seeded: number;
  /** Nansen labels known here. */
  named: number;
};

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * "watching 1,200 of 1,377 SMART wallets · 147 named" when every wallet passed its smart-money check; with seeded wallets still
 * pending the population is split so an unverified wallet is never called SMART: "watching 600 of 1,502 wallets · 1,495 SMART
 * · 7 seeded pending · 147 named". Watched never reads above population.
 */
function coverageLabel(input: CoverageInput): string {
  const population = count(input.population);
  const watched = Math.min(count(input.watched), population);
  const seeded = Math.min(count(input.seeded), population);
  const named = `${INT.format(count(input.named))} named`;
  if (seeded === 0) return `watching ${INT.format(watched)} of ${INT.format(population)} SMART wallets · ${named}`;
  return `watching ${INT.format(watched)} of ${INT.format(population)} wallets · ${INT.format(population - seeded)} SMART · ${INT.format(seeded)} seeded pending · ${named}`;
}

/** The wire shape every SMART route carries; computed once in TraderService.coverage(). */
export function buildCoverage(input: CoverageInput): SmartCoverage {
  const population = count(input.population);
  return { watched: Math.min(count(input.watched), population), population, label: coverageLabel(input) };
}

/** Failure branches: same shape, zeros, and a label that says so. */
export function emptyCoverage(): SmartCoverage {
  return buildCoverage({ watched: 0, population: 0, seeded: 0, named: 0 });
}
