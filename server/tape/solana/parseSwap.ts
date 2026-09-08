import type { FlowPrint, PairRow } from "../../../shared/wire.js";
import { perTokenPrice } from "../../flow/printPrice.js";
import { pumpPoolFor } from "../../sources/pumpfun.js";

/** Raydium AMM v4 vaults are owned by this authority PDA, not by the pool account. */
export const RAYDIUM_V4_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1e9;
const PUMP_PREFIX = "pumpfun:";
const PUMP_VENUES = new Set(["pumpfun", "pumpswap", "pumpamm"]);

/** A Tier A pool to attribute vault deltas to. `ledgerPair` is the id emitted on prints (see poolRefsFromRegistry). */
export type PoolRef = { pair: string; pairAddress: string; dex: string; ledgerPair: string };

export type TokenDelta = { account: string; owner: string | null; mint: string; delta: number };

export type ParseContext = {
  mint: string;
  pools: PoolRef[];
  quotePriceUsd: (mint: string) => number | null;
  blockTimeMs?: number;
};

export type ParseResult = { prints: FlowPrint[]; unattributed: number; skipped: string | null };

type Record_ = Record<string, unknown>;
type QuoteMove = { mint: string; delta: number };

function record(value: unknown): Record_ {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** jsonParsed accountKeys are `{ pubkey, signer, writable, source }`; legacy encodings may hand back bare strings. */
function accountKey(keys: unknown[], index: number): string | null {
  const entry = keys[index];
  return typeof entry === "string" ? entry : text(record(entry).pubkey);
}

function accountIndexOf(keys: unknown[], address: string): number {
  return keys.findIndex((_, index) => accountKey(keys, index) === address);
}

function signers(keys: unknown[]): Set<string> {
  const out = new Set<string>();
  keys.forEach((entry, index) => {
    if (record(entry).signer === true) {
      const key = accountKey(keys, index);
      if (key) out.add(key);
    }
  });
  return out;
}

type RawBalance = { index: number; amount: bigint; decimals: number; mint: string; owner: string | null };

function rawBalance(entry: unknown): RawBalance | null {
  const row = record(entry);
  const ui = record(row.uiTokenAmount);
  const index = Number(row.accountIndex);
  const mint = text(row.mint);
  const decimals = Number(ui.decimals);
  if (!Number.isInteger(index) || !mint || !Number.isInteger(decimals) || typeof ui.amount !== "string") return null;
  try {
    return { index, amount: BigInt(ui.amount), decimals, mint, owner: text(row.owner) };
  } catch {
    return null;
  }
}

function scaled(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Per token account: uiAmount(post) - uiAmount(pre), computed from raw amounts so precision matches the chain.
 * An account present on only one side is treated as zero on the other (created or closed in-tx).
 */
export function tokenDeltas(tx: unknown): TokenDelta[] {
  const meta = record(record(tx).meta);
  const keys = list(record(record(record(tx).transaction).message).accountKeys);
  const pre = new Map<number, RawBalance>();
  for (const entry of list(meta.preTokenBalances)) {
    const balance = rawBalance(entry);
    if (balance) pre.set(balance.index, balance);
  }
  const merged = new Map<number, TokenDelta>();
  for (const entry of list(meta.postTokenBalances)) {
    const post = rawBalance(entry);
    if (!post) continue;
    const before = pre.get(post.index);
    const account = accountKey(keys, post.index) ?? String(post.index);
    merged.set(post.index, {
      account,
      owner: post.owner ?? before?.owner ?? null,
      mint: post.mint,
      delta: scaled(post.amount - (before?.amount ?? 0n), post.decimals)
    });
  }
  for (const [index, before] of pre) {
    if (merged.has(index)) continue;
    const account = accountKey(keys, index) ?? String(index);
    merged.set(index, { account, owner: before.owner, mint: before.mint, delta: scaled(-before.amount, before.decimals) });
  }
  return [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([, delta]) => delta);
}

/** Account lists of every top-level and inner instruction that exposes one (parsed system/token ixs do not). */
function instructionAccounts(tx: unknown): string[][] {
  const message = record(record(record(tx).transaction).message);
  const inner = list(record(record(tx).meta).innerInstructions).flatMap((group) => list(record(group).instructions));
  return [...list(message.instructions), ...inner]
    .map((ix) => list(record(ix).accounts).filter((account): account is string => typeof account === "string"))
    .filter((accounts) => accounts.length > 0);
}

function sharesInstruction(ixAccounts: string[][], vault: string, pool: string): boolean {
  return ixAccounts.some((accounts) => accounts.includes(vault) && accounts.includes(pool));
}

/** Vault owner == pool address on Orca, Meteora DLMM, PumpSwap and Raydium CLMM; AMM v4 vaults hang off the authority PDA. */
function belongsTo(delta: TokenDelta, pool: PoolRef, ixAccounts: string[][]): boolean {
  if (delta.owner === pool.pairAddress) return true;
  return delta.owner === RAYDIUM_V4_AUTHORITY && sharesInstruction(ixAccounts, delta.account, pool.pairAddress);
}

/** Largest non-zero quote-side vault move for the pool; null when no quote vault moved. */
function tokenQuote(vaults: TokenDelta[], mint: string): QuoteMove | null {
  const moves = vaults.filter((vault) => vault.mint !== mint && vault.delta !== 0);
  if (!moves.length) return null;
  const top = moves.reduce((best, vault) => (Math.abs(vault.delta) > Math.abs(best.delta) ? vault : best));
  return { mint: top.mint, delta: top.delta };
}

/** Fallback for pools that hold native SOL on the pool account itself rather than in a WSOL vault. */
function nativeQuote(tx: unknown, pool: PoolRef): QuoteMove | null {
  const meta = record(record(tx).meta);
  const keys = list(record(record(record(tx).transaction).message).accountKeys);
  const index = accountIndexOf(keys, pool.pairAddress);
  if (index < 0) return null;
  const pre = Number(list(meta.preBalances)[index]);
  const post = Number(list(meta.postBalances)[index]);
  if (!Number.isFinite(pre) || !Number.isFinite(post) || post === pre) return null;
  return { mint: SOL_MINT, delta: (post - pre) / LAMPORTS_PER_SOL };
}

function sumMint(vaults: TokenDelta[], mint: string): number {
  return vaults.filter((vault) => vault.mint === mint).reduce((sum, vault) => sum + vault.delta, 0);
}

function priceUsd(quote: QuoteMove, ctx: ParseContext): number | null {
  const price = ctx.quotePriceUsd(quote.mint);
  return price !== null && Number.isFinite(price) && price > 0 ? Math.abs(quote.delta) * price : null;
}

/** One print per pool iff its token vault and quote vault both moved in opposite directions. */
function poolPrint(tx: unknown, pool: PoolRef, vaults: TokenDelta[], ctx: ParseContext, sig: string, time: number): FlowPrint | null {
  const mintDelta = sumMint(vaults, ctx.mint);
  if (mintDelta === 0) return null;
  const quote = tokenQuote(vaults, ctx.mint) ?? nativeQuote(tx, pool);
  if (!quote || quote.delta === 0 || Math.sign(quote.delta) === Math.sign(mintDelta)) return null;
  const usd = priceUsd(quote, ctx);
  return {
    chain: "solana",
    pair: pool.ledgerPair,
    tx: sig,
    time,
    side: mintDelta < 0 ? "buy" : "sell",
    usd,
    source: "own",
    quantity: Math.abs(mintDelta),
    ...perTokenPrice(usd, mintDelta)
  };
}

function blockTimeMs(tx: unknown, ctx: ParseContext): number | null {
  const blockTime = Number(record(tx).blockTime);
  if (Number.isFinite(blockTime) && blockTime > 0) return blockTime * 1000;
  return ctx.blockTimeMs !== undefined && Number.isFinite(ctx.blockTimeMs) ? ctx.blockTimeMs : null;
}

function skipReason(tx: unknown, ctx: ParseContext): string | null {
  const root = record(tx);
  if (!Object.keys(root).length || !Object.keys(record(root.meta)).length) return "malformed tx";
  if (record(root.meta).err !== null && record(root.meta).err !== undefined) return "failed tx";
  if (!text(list(record(root.transaction).signatures)[0])) return "missing signature";
  if (blockTimeMs(tx, ctx) === null) return "missing block time";
  return null;
}

/**
 * Parse one getTransaction(jsonParsed) result into own-tape prints for the Tier A pools in `ctx.pools`.
 * Token-mint moves on accounts that are neither a Tier A vault nor owned by a signer (the trader's own ATAs)
 * are counted in `unattributed` — typically Tier B pool legs, which must not be ingested.
 */
export function parseSwapTransaction(tx: unknown, ctx: ParseContext): ParseResult {
  const skipped = skipReason(tx, ctx);
  if (skipped) return { prints: [], unattributed: 0, skipped };
  const sig = text(list(record(record(tx).transaction).signatures)[0]) as string;
  const time = blockTimeMs(tx, ctx) as number;
  const deltas = tokenDeltas(tx);
  const ixAccounts = instructionAccounts(tx);
  const attributed = new Set<TokenDelta>();
  const prints: FlowPrint[] = [];
  for (const pool of ctx.pools) {
    const vaults = deltas.filter((delta) => belongsTo(delta, pool, ixAccounts));
    vaults.forEach((vault) => attributed.add(vault));
    const print = poolPrint(tx, pool, vaults, ctx, sig, time);
    if (print) prints.push(print);
  }
  const signerKeys = signers(list(record(record(record(tx).transaction).message).accountKeys));
  // A fee payer alone is not an owner. Attribute only one signer whose own token accounts moved in the trade direction.
  for (const print of prints) {
    const moves = new Map<string, number>();
    for (const delta of deltas) if (delta.mint === ctx.mint && delta.owner && signerKeys.has(delta.owner) && !attributed.has(delta)) moves.set(delta.owner, (moves.get(delta.owner) ?? 0) + delta.delta);
    const owners = [...moves].filter(([, amount]) => print.side === "buy" ? amount > 0 : amount < 0);
    if (owners.length === 1) {
      print.trader = { address: owners[0][0], kind: "other", handle: null, followers: null };
      print.identitySource = "signer-owned token balance change";
    }
  }
  const unattributed = deltas.filter(
    (delta) => delta.mint === ctx.mint && delta.delta !== 0 && !attributed.has(delta) && !(delta.owner && signerKeys.has(delta.owner))
  ).length;
  return { prints, unattributed, skipped: null };
}

function isPumpVenue(dex: string): boolean {
  return PUMP_VENUES.has(dex.toLowerCase().replace(/[^a-z]/g, ""));
}

/**
 * Registry rows -> pools the own tape should attribute. Tier A on-chain pools emit under their own address;
 * pump-venue pools emit under the pump pseudo-pair whenever the registry carries it, so a tx already ingested from
 * pump v2 dedupes on (chain, tx, pair) instead of double counting. The pseudo-pair row itself has no on-chain address.
 */
export function poolRefsFromRegistry(rows: PairRow[], mint: string): PoolRef[] {
  const hasPseudoPair = rows.some((row) => row.pairAddress.startsWith(PUMP_PREFIX));
  return rows.flatMap((row) => {
    if (row.pairAddress.startsWith(PUMP_PREFIX)) return [];
    if (hasPseudoPair && isPumpVenue(row.dex)) {
      return [{ pair: row.pairAddress, pairAddress: row.pairAddress, dex: row.dex, ledgerPair: pumpPoolFor(mint) }];
    }
    if (row.tier !== "A") return [];
    return [{ pair: row.pairAddress, pairAddress: row.pairAddress, dex: row.dex, ledgerPair: row.pairAddress }];
  });
}
