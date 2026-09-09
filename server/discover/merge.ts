import type { Chain, DiscoverDisputedField, DiscoverFigures, DiscoverProvenance, DiscoverRow, DiscoverView } from "../../shared/wire.js";

/** Two sources disagreeing by more than this (relative to the larger figure) are reported side by side, never averaged. */
export const DISAGREE_FRACTION = 0.05;
export const DISPUTABLE_FIELDS: readonly DiscoverDisputedField[] = ["priceUsd", "marketCapUsd", "liquidityUsd", "volumeUsd", "changePct"];

/** One source's row before merging; `token` is already lowercased by the provider. */
export type DiscoverPartial = DiscoverProvenance & { token: string };

const FIGURE_FIELDS: readonly (keyof DiscoverFigures)[] = [
  "priceUsd",
  "marketCapUsd",
  "liquidityUsd",
  "volumeUsd",
  "changePct",
  "txns",
  "ageMs",
  "pool",
  "dex",
  "fomoHolders",
  "trackedBuyers"
];

export function emptyFigures(): DiscoverFigures {
  return { priceUsd: null, marketCapUsd: null, liquidityUsd: null, volumeUsd: null, changePct: null, txns: null, ageMs: null, pool: null, dex: null, fomoHolders: null, trackedBuyers: null };
}

function firstNonNull<T>(values: readonly (T | null)[]): T | null {
  for (const value of values) if (value !== null && value !== undefined) return value;
  return null;
}

/** True when the spread between the smallest and largest figure exceeds DISAGREE_FRACTION of the larger magnitude. */
export function disagrees(values: readonly number[]): boolean {
  if (values.length < 2) return false;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const scale = Math.max(Math.abs(min), Math.abs(max));
  if (scale === 0) return false;
  return (max - min) / scale > DISAGREE_FRACTION;
}

function disputedFields(sources: readonly DiscoverProvenance[]): DiscoverDisputedField[] {
  return DISPUTABLE_FIELDS.filter((field) => disagrees(sources.map((source) => source[field]).filter((value): value is number => value !== null)));
}

/** Sources are kept in precedence order; the same source name contributing twice keeps its first (higher-ranked) entry. */
function orderSources(partials: readonly DiscoverPartial[], precedence: readonly string[]): DiscoverProvenance[] {
  const rankOf = (source: string) => {
    const index = precedence.indexOf(source);
    return index === -1 ? precedence.length : index;
  };
  const seen = new Set<string>();
  return [...partials]
    .sort((a, b) => rankOf(a.source) - rankOf(b.source))
    .filter((partial) => {
      if (seen.has(partial.source)) return false;
      seen.add(partial.source);
      return true;
    })
    .map(({ token: _token, ...provenance }) => provenance);
}

function mergeOne(chain: Chain, token: string, partials: readonly DiscoverPartial[], precedence: readonly string[]): DiscoverRow {
  const sources = orderSources(partials, precedence);
  const figures = emptyFigures() as Record<keyof DiscoverFigures, unknown>;
  for (const field of FIGURE_FIELDS) figures[field] = firstNonNull(sources.map((source) => source[field]));
  return {
    ...(figures as DiscoverFigures),
    chain,
    token,
    symbol: firstNonNull(sources.map((source) => source.symbol)),
    name: firstNonNull(sources.map((source) => source.name)),
    sources,
    disputed: disputedFields(sources)
  };
}

/**
 * Groups partial rows by token (case-insensitive) into one DiscoverRow each. Top-level figures take the first non-null
 * value in `precedence` order; every source's own figures stay on `sources[]` and `disputed` names the fields where any two
 * sources differ by more than DISAGREE_FRACTION. Nothing is averaged, nothing is forward-filled.
 */
export function mergeDiscover(chain: Chain, partials: readonly DiscoverPartial[], precedence: readonly string[]): DiscoverRow[] {
  const byToken = new Map<string, DiscoverPartial[]>();
  for (const partial of partials) {
    const key = chain === "solana" ? partial.token : partial.token.toLowerCase();
    if (!key) continue;
    byToken.set(key, [...(byToken.get(key) ?? []), { ...partial, token: key }]);
  }
  return [...byToken.entries()].map(([token, group]) => mergeOne(chain, token, group, precedence));
}

/** Best rank a row holds in `source`'s own ordering, or null when that source did not list it. */
export function sourceRank(row: DiscoverRow, source: string): number | null {
  const entry = row.sources.find((provenance) => provenance.source === source);
  return entry?.rank ?? null;
}

function nullsLast(a: number | null, b: number | null, descending: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

function txnCount(row: DiscoverRow): number | null {
  return row.txns ? row.txns.buys + row.txns.sells : null;
}

/**
 * View ordering. trending: the ranked source's order first, then everything else by window volume; movers: absolute
 * change, largest first (rows with no change figure are dropped, not ranked as 0); new: youngest first, unknown age last;
 * holders: most distinct verified-FOMO buyers first (rows with none are dropped: no buyers seen is not a rank).
 */
export function rankRows(view: DiscoverView, rows: readonly DiscoverRow[], rankedSource: string | null): DiscoverRow[] {
  const byToken = (a: DiscoverRow, b: DiscoverRow) => a.token.localeCompare(b.token);
  if (view === "movers") {
    return rows
      .filter((row) => row.changePct !== null)
      .sort((a, b) => Math.abs(b.changePct as number) - Math.abs(a.changePct as number) || nullsLast(a.volumeUsd, b.volumeUsd, true) || byToken(a, b));
  }
  if (view === "new") {
    return [...rows].sort((a, b) => nullsLast(a.ageMs, b.ageMs, false) || nullsLast(a.volumeUsd, b.volumeUsd, true) || byToken(a, b));
  }
  if (view === "holders") {
    return rows
      .filter((row) => row.fomoHolders !== null && row.fomoHolders > 0)
      .sort((a, b) => (b.fomoHolders as number) - (a.fomoHolders as number) || nullsLast(a.volumeUsd, b.volumeUsd, true) || byToken(a, b));
  }
  return [...rows].sort((a, b) => {
    const ranked = nullsLast(rankedSource ? sourceRank(a, rankedSource) : null, rankedSource ? sourceRank(b, rankedSource) : null, false);
    return ranked || nullsLast(a.volumeUsd, b.volumeUsd, true) || nullsLast(txnCount(a), txnCount(b), true) || byToken(a, b);
  });
}
