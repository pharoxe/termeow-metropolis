import { z } from "zod";
import type { FlowPrint, LaunchRow } from "../../shared/wire.js";
import type { LedgerRestoreResult, LedgerSnapshot } from "../flow/ledger.js";
import { DEFAULT_MAX_LAUNCHES, type LaunchIndexSnapshot } from "../launch/index.js";
import { DEFAULT_FILL_RING, type TraderBookSnapshot } from "../traders/book.js";
import { DEFAULT_ERC20_META_MAX, type Erc20MetaEntry } from "../traders/erc20Meta.js";
import type { HandleEntry } from "../traders/handles.js";
import { DEFAULT_POPULATION_MAX, type TraderServiceRestoreCounts, type TraderServiceSnapshot } from "../traders/service.js";
import type { TraderFill } from "../traders/walletStats.js";

const HOUR_MS = 3_600_000;
/** Rings and rows describe a moving market; past this they are not worth putting back. */
export const MAX_AGE_ROWS_MS = 48 * HOUR_MS;
export const MAX_AGE_RINGS_MS = 6 * HOUR_MS;
/** decimals()/symbol() are immutable on-chain facts. */
export const MAX_AGE_FACTS_MS = 30 * 24 * HOUR_MS;
export const SEEDED_CAP = 5_000;
export const HANDLES_LEARNED_CAP = 5_000;
export const LEDGER_GENERAL_PAIRS_CAP = 64;
export const LEDGER_FOMO_PAIRS_CAP = 256;
export const LEDGER_RING_CAP = 200;

/** Owner-agnostic contract the manager drives: collect() answers null while the owner has not been constructed yet. */
export type ComponentSpec<T> = {
  name: string;
  version: number;
  maxAgeMs: number;
  collect(): { data: T; truncated: number } | null;
  parse(data: unknown): T | null;
  /** Applies validated data; answers null when the owner is still missing. Counts are whatever the owner reports. */
  restore(data: T): Record<string, number> | null;
};

const EVM_ADDRESS = /^0x[a-f0-9]{40}$/i;
const chainSchema = z.enum(["solana", "robinhood"]);
const sideSchema = z.enum(["buy", "sell"]);
const finiteOrNull = z.number().finite().nullable();

const printSchema = z
  .object({
    chain: chainSchema,
    pair: z.string().min(1),
    tx: z.string().min(1),
    time: z.number().finite(),
    side: sideSchema,
    usd: finiteOrNull,
    source: z.enum(["pumpfun", "geckoterminal", "own"])
  })
  .passthrough();

const fillSchema = printSchema.extend({ trader: z.string().min(1), token: z.string().min(1) });

const identitySchema = z.object({
  chain: chainSchema,
  wallet: z.string().min(1),
  identity: z.object({ handle: z.string().nullable(), followers: finiteOrNull, kind: z.enum(["fomo", "other", "seeded"]).nullable() })
});

const launchRowSchema = z
  .object({
    chain: chainSchema,
    launchpad: z.string().min(1),
    token: z.string().min(1),
    createdAt: z.number().finite(),
    observedAt: z.number().finite(),
    sources: z.array(z.string()),
    curveBuys: z.number().finite(),
    curveSells: z.number().finite()
  })
  .passthrough();

const handleEntrySchema = z.object({
  handle: z.string().min(1),
  followers: finiteOrNull,
  profileUrl: z.string().nullable(),
  source: z.literal("learned")
});

const seedSchema = z.object({ address: z.string().regex(EVM_ADDRESS), provenance: z.string(), at: z.number().finite(), attempts: z.number().int().nonnegative() });

const erc20Schema = z.tuple([
  z.string().regex(EVM_ADDRESS),
  z.object({ decimals: z.number().int().min(0).max(255).nullable(), symbol: z.string().nullable(), resolvedAt: z.number().finite() })
]);

const launchSnapshotSchema = z.object({ rows: z.array(launchRowSchema), stocks: z.array(z.string()) });
const bookSnapshotSchema = z.object({ fills: z.array(fillSchema), identities: z.array(identitySchema) });
const traderSnapshotSchema = z.object({
  population: z.array(z.string().regex(EVM_ADDRESS)),
  seeded: z.array(seedSchema),
  handlesLearned: z.array(z.tuple([z.string().regex(EVM_ADDRESS), handleEntrySchema]))
});
const erc20SnapshotSchema = z.array(erc20Schema);
const ledgerSnapshotSchema = z.object({
  pairs: z.array(z.object({ key: z.string().min(1), recent: z.array(printSchema), firstPrintAt: finiteOrNull }))
});

export function parseWith<T>(schema: z.ZodType<T>): (data: unknown) => T | null {
  return (data) => {
    const result = schema.safeParse(data);
    return result.success ? result.data : null;
  };
}

/** Keeps the last `cap` items (owners emit oldest first, so the tail is the freshest). */
export function tail<T>(items: T[], cap: number): { items: T[]; truncated: number } {
  return items.length <= cap ? { items, truncated: 0 } : { items: items.slice(items.length - cap), truncated: items.length - cap };
}

export type LaunchIndexLike = { snapshot(): LaunchIndexSnapshot; restore(snapshot: LaunchIndexSnapshot): number };
export type TraderBookLike = { snapshot(): TraderBookSnapshot; restore(snapshot: TraderBookSnapshot): { accepted: number; duplicates: number; rejected: number } };
export type TraderServiceLike = { snapshot(): TraderServiceSnapshot; restore(snapshot: TraderServiceSnapshot): TraderServiceRestoreCounts };
export type Erc20MetaLike = { snapshot(): [string, Erc20MetaEntry][]; restore(entries: [string, Erc20MetaEntry][]): number };
export type LedgerLike = { snapshot(): LedgerSnapshot; restore(snapshot: LedgerSnapshot): LedgerRestoreResult };

export function launchIndexComponent(owner: () => LaunchIndexLike | null, cap = DEFAULT_MAX_LAUNCHES): ComponentSpec<LaunchIndexSnapshot> {
  return {
    name: "launch-index",
    version: 1,
    maxAgeMs: MAX_AGE_ROWS_MS,
    collect: () => {
      const index = owner();
      if (!index) return null;
      const snapshot = index.snapshot();
      const newestFirst = [...snapshot.rows].sort((a, b) => a.createdAt - b.createdAt);
      const kept = tail(newestFirst, cap);
      return { data: { rows: kept.items, stocks: snapshot.stocks }, truncated: kept.truncated };
    },
    parse: (data) => parseWith(launchSnapshotSchema)(data) as LaunchIndexSnapshot | null,
    restore: (data) => {
      const index = owner();
      return index ? { rows: index.restore({ rows: data.rows as LaunchRow[], stocks: data.stocks }) } : null;
    }
  };
}

export function traderBookComponent(owner: () => TraderBookLike | null, cap = DEFAULT_FILL_RING): ComponentSpec<TraderBookSnapshot> {
  return {
    name: "trader-book",
    version: 1,
    maxAgeMs: MAX_AGE_ROWS_MS,
    collect: () => {
      const book = owner();
      if (!book) return null;
      const snapshot = book.snapshot();
      const kept = tail(snapshot.fills, cap);
      return { data: { fills: kept.items, identities: snapshot.identities }, truncated: kept.truncated };
    },
    parse: (data) => parseWith(bookSnapshotSchema)(data) as TraderBookSnapshot | null,
    restore: (data) => {
      const book = owner();
      if (!book) return null;
      const result = book.restore({ fills: data.fills as TraderFill[], identities: data.identities });
      return { fills: result.accepted, duplicates: result.duplicates, rejected: result.rejected };
    }
  };
}

export function traderServiceComponent(owner: () => TraderServiceLike | null): ComponentSpec<TraderServiceSnapshot> {
  return {
    name: "trader-population",
    version: 1,
    maxAgeMs: MAX_AGE_ROWS_MS,
    collect: () => {
      const service = owner();
      if (!service) return null;
      const snapshot = service.snapshot();
      const population = tail(snapshot.population, DEFAULT_POPULATION_MAX);
      const seeded = tail(snapshot.seeded, SEEDED_CAP);
      const handles = tail(snapshot.handlesLearned, HANDLES_LEARNED_CAP);
      return {
        data: { population: population.items, seeded: seeded.items, handlesLearned: handles.items },
        truncated: population.truncated + seeded.truncated + handles.truncated
      };
    },
    parse: parseWith(traderSnapshotSchema),
    restore: (data) => owner()?.restore(data) ?? null
  };
}

export function erc20MetaComponent(owner: () => Erc20MetaLike | null, cap = DEFAULT_ERC20_META_MAX): ComponentSpec<[string, Erc20MetaEntry][]> {
  return {
    name: "erc20-meta",
    version: 1,
    maxAgeMs: MAX_AGE_FACTS_MS,
    collect: () => {
      const meta = owner();
      if (!meta) return null;
      const kept = tail(meta.snapshot(), cap);
      return { data: kept.items, truncated: kept.truncated };
    },
    parse: parseWith(erc20SnapshotSchema),
    restore: (data) => {
      const meta = owner();
      return meta ? { entries: meta.restore(data) } : null;
    }
  };
}

export function ledgerComponent(name: string, owner: () => LedgerLike | null, pairsCap: number, ringCap = LEDGER_RING_CAP): ComponentSpec<LedgerSnapshot> {
  return {
    name,
    version: 1,
    maxAgeMs: MAX_AGE_RINGS_MS,
    collect: () => {
      const ledger = owner();
      if (!ledger) return null;
      const pairs = tail(ledger.snapshot().pairs, pairsCap);
      let truncated = pairs.truncated;
      const trimmed = pairs.items.map((pair) => {
        const ring = tail(pair.recent, ringCap);
        truncated += ring.truncated;
        return { ...pair, recent: ring.items };
      });
      return { data: { pairs: trimmed }, truncated };
    },
    parse: (data) => parseWith(ledgerSnapshotSchema)(data) as LedgerSnapshot | null,
    restore: (data) => {
      const ledger = owner();
      if (!ledger) return null;
      const result = ledger.restore({ pairs: data.pairs.map((pair) => ({ ...pair, recent: pair.recent as FlowPrint[] })) });
      return { pairs: result.pairs, prints: result.prints };
    }
  };
}
