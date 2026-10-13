import type { AggregateFlow } from "../../shared/aggregateFlow.js";
import type { FlowBucket } from "../../shared/wire.js";
import { DatabaseSync } from "node:sqlite";
import type { Chain, FlowPrint, PairRow } from "../../shared/wire.js";
import { chainKey, type TradeEvent, type TradeHistory } from "../../shared/terminal.js";

/** Indexed durable observations. Exact executions supersede coarse provider rows for the same tx/pair. */
export class TradeArchive {
  private db: DatabaseSync;
  private sequence = 0;
  private scopeRevisions = new Map<string,number>();
  private listeners = new Set<() => void>();
  private pairs = new Map<string, { token: string; dex: string }>();
  private walletCache = new Map<Chain, { at: number; wallets: string[] }>();
  error: string | null = null;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    // A full persistent volume is commonly a large WAL rather than live data.
    // Reclaim it before schema writes so startup can recover without shell access.
    if (path !== ":memory:") { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ } }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, chain TEXT NOT NULL, token TEXT NOT NULL, pair TEXT NOT NULL, tx TEXT NOT NULL, time INTEGER NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trades_range ON trades(chain,token,time,id);
      CREATE INDEX IF NOT EXISTS trades_execution ON trades(chain,token,pair,tx);
      CREATE TABLE IF NOT EXISTS observations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, received INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trades_revision ON trades(revision);
      CREATE TABLE IF NOT EXISTS changes (revision INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, received INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairs (chain TEXT, pair TEXT, token TEXT, dex TEXT, PRIMARY KEY(chain,pair));`);
    this.sequence = Number((this.db.prepare("SELECT COALESCE(MAX(revision),0) AS n FROM changes").get() as {n:number}).n);
    for (const row of this.db.prepare("SELECT chain,token,MAX(revision) revision FROM trades GROUP BY chain,token").all() as Array<{chain:string;token:string;revision:number}>) this.scopeRevisions.set(`${row.chain}:${row.token}`,row.revision);
    for (const row of this.db.prepare("SELECT * FROM pairs").all() as Array<{chain: Chain; pair: string; token: string; dex: string}>) this.pairs.set(`${row.chain}:${row.pair}`, row);
  }
  prune(before: { observations: number; trades: number }, batch = 1000) {
    const remove = (table: "observations" | "changes" | "trades", column: "received" | "time", cutoff: number) => {
      const result = this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`)
        .run(cutoff, batch);
      return Number(result.changes);
    };
    try {
      const observations = remove("observations", "received", before.observations);
      const changes = remove("changes", "received", before.trades);
      const trades = remove("trades", "time", before.trades);
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (trades) this.walletCache.clear();
      return { observations, changes, trades };
    } catch (reason) {
      this.error = String(reason);
      return { observations: 0, changes: 0, trades: 0 };
    }
  }
  bind(chain: Chain, token: string, rows: PairRow[]) {
    for (const row of rows) {
      const pair = chainKey(chain, row.pairAddress);
      const entry = { token: chainKey(chain, token), dex: row.dex };
      // Pool-oriented producers currently decode one focused base asset per pair; avoid reassigning archived trades.
      const existing = this.pairs.get(`${chain}:${pair}`);
      if (existing && existing.token !== entry.token) continue;
      this.pairs.set(`${chain}:${pair}`, entry);
      this.db.prepare("INSERT OR REPLACE INTO pairs VALUES (?,?,?,?)").run(chain, pair, entry.token, entry.dex);
    }
  }
  ingest(prints: FlowPrint[], tokenHint?: string, dexHint?: string) {
    let changed = false;
    const changedScopes=new Map<string,number>();
    try {
      this.db.exec("BEGIN");
      for (const p of prints) {
        if (!Number.isFinite(p.time) || p.time > Date.now() + 60_000 || !p.tx || !p.pair || !["buy", "sell"].includes(p.side)) continue;
        const pair = chainKey(p.chain, p.pair);
        const binding = this.pairs.get(`${p.chain}:${pair}`);
        const token = tokenHint ? chainKey(p.chain, tokenHint) : binding?.token;
        if (!token) continue;
        const tx = chainKey(p.chain, p.tx);
        const wallet = p.trader?.address ? chainKey(p.chain, p.trader.address) : null;
        const granularity = p.eventId ? "execution" : pair.startsWith("smart:") ? "wallet-net" : "transaction-pool";
        const id = [p.chain, token, tx, pair, p.eventId ?? (granularity === "wallet-net" ? `${wallet}:${p.side}` : p.side)].join(":");
        const oldRow = this.db.prepare("SELECT body FROM trades WHERE id=?").get(id) as {body: string} | undefined;
        const old: TradeEvent | undefined = oldRow ? JSON.parse(oldRow.body) : undefined;
        // A lower fidelity provider cannot overwrite a decoded price, but may enrich a missing identity.
        const preferOld = old?.source === "own" && p.source !== "own";
        const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
        // Split out so the labels below can say whether the numbers came from this print or were carried over.
        const freshPrice = preferOld ? null : positive(p.price);
        const freshUsd = preferOld ? null : (typeof p.usd === "number" && Number.isFinite(p.usd) && p.usd >= 0 ? p.usd : null);
        const price = freshPrice ?? old?.price ?? null;
        const usd = freshUsd ?? old?.usd ?? null;
        const source = preferOld ? old.source : p.source;
        // The token amount a producer read off the chain, kept across a later coarser delivery of the same event.
        const decoded = positive(p.quantity) ?? (old?.quantitySource === "decoded" ? positive(old.quantity) : null);
        // Otherwise divide the usd and price this row is showing. Exact arithmetic, but only ever as honest as the two
        // numbers it divides, so the label below says whose they are instead of calling both cases "estimated".
        const divided = price && usd != null ? usd / price : null;
        // "derived" claims exact arithmetic over numbers decoded here, so it holds only when every input came from an
        // "own"-source observation. A usd or price carried over from an earlier provider row keeps the weaker
        // "provider-estimated" label even when this print's own `source` is "own": the row's source is not the
        // division's source.
        const dividedOwn = (freshPrice != null ? p.source === "own" : old?.source === "own") && (freshUsd != null ? p.source === "own" : old?.source === "own");
        const event: TradeEvent = {
          id, revision: old?.revision ?? 0, chain: p.chain, token, pair, dex: dexHint ?? binding?.dex ?? old?.dex ?? "unknown",
          tx, time: preferOld ? old.time : p.time, receivedAt: old?.receivedAt ?? Date.now(), side: p.side, usd, price,
          wallet: wallet ?? old?.wallet ?? null, handle: p.trader?.handle ?? old?.handle ?? null,
          kind: p.trader?.kind ?? old?.kind ?? null,
          followers: typeof p.trader?.followers === "number" && Number.isFinite(p.trader.followers) && p.trader.followers >= 0 ? p.trader.followers : old?.followers ?? null,
          identitySource: p.trader?.handle ? "public provider mapping" : wallet ? (p.identitySource ?? "receipt attribution") : old?.identitySource ?? "unattributed",
          source, granularity,
          quantity: decoded ?? divided ?? old?.quantity ?? null,
          quantitySource: decoded != null ? "decoded" : divided != null ? (dividedOwn ? "derived" : "provider-estimated") : old?.quantity != null ? (old.quantitySource ?? "unknown") : "unknown",
          confirmation: "observed"
        };
        if (old && JSON.stringify(event) === JSON.stringify(old)) continue;
        this.db.prepare("INSERT INTO observations(received,payload) VALUES (?,?)").run(Date.now(),JSON.stringify(p));
        event.revision = Number(this.db.prepare("INSERT INTO changes(id,received) VALUES (?,?)").run(id, Date.now()).lastInsertRowid);
        this.sequence = event.revision;
        this.db.prepare("INSERT OR REPLACE INTO trades VALUES (?,?,?,?,?,?,?,?)").run(id, p.chain, token, pair, tx, event.time, event.revision, JSON.stringify(event));
        changedScopes.set(`${p.chain}:${token}`,event.revision);
        changed = true;
      }
      this.db.exec("COMMIT"); for(const [key,revision] of changedScopes)this.scopeRevisions.set(key,revision); this.error = null;
    } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} this.error = String(e); }
    if (changed) for (const fn of this.listeners) fn();
  }
  revision(chain?:Chain,token?:string) { return chain&&token ? this.scopeRevisions.get(`${chain}:${chainKey(chain,token)}`)??0 : this.sequence; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  history(chain: Chain, token: string, from: number, to: number, limit = 500, cursor?: string): TradeHistory {
    token = chainKey(chain, token);
    let after: [number, string] | null = null;
    if (cursor) { const value = JSON.parse(Buffer.from(cursor, "base64url").toString()); if (!Array.isArray(value) || !Number.isFinite(value[0]) || typeof value[1] !== "string") throw new Error("Invalid cursor"); after = value as [number,string]; }
    // An exact log replaces a coarse tx/pool observation; wallet-net rows stay distinct and are excluded from OHLCV.
    const where = `chain=? AND token=? AND time>=? AND time<=? AND (json_extract(body,'$.granularity') <> 'transaction-pool' OR NOT EXISTS (SELECT 1 FROM trades exact WHERE exact.chain=trades.chain AND exact.token=trades.token AND exact.pair=trades.pair AND exact.tx=trades.tx AND json_extract(exact.body,'$.granularity')='execution'))`;
    const args = [chain, token, from, to];
    const count = (this.db.prepare(`SELECT COUNT(*) n FROM trades WHERE ${where}`).get(...args) as {n: number}).n;
    const first = (this.db.prepare("SELECT MIN(time) n FROM trades WHERE chain=? AND token=?").get(chain, token) as {n: number|null}).n;
    const rows = this.db.prepare(`SELECT body FROM trades WHERE ${where}${after ? " AND (time<? OR (time=? AND id<?))" : ""} ORDER BY time DESC,id DESC LIMIT ?`).all(...args, ...(after ? [after[0], after[0], after[1]] : []), limit + 1) as {body:string}[];
    const events: TradeEvent[] = rows.slice(0,limit).map(row => JSON.parse(row.body));
    const last = events.at(-1);
    return { events, matched: count, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.time,last.id])).toString("base64url") : null, revision: this.revision(), from, to, observedAt: Date.now(), firstObservedAt: first, coverage: "captured-only", ...(this.error ? {error:this.error} : {}) };
  }
  aggregate(chain: Chain, token: string, from: number, to: number, intervalMs: number): AggregateFlow {
    token = chainKey(chain, token);
    // Aggregate the entire requested archive range in SQL, independent of tape pagination and UI filters.
    const population = `json_extract(body,'$.granularity')!='wallet-net' AND (json_extract(body,'$.granularity')!='transaction-pool' OR NOT EXISTS (SELECT 1 FROM trades exact WHERE exact.chain=trades.chain AND exact.token=trades.token AND exact.pair=trades.pair AND exact.tx=trades.tx AND json_extract(exact.body,'$.granularity')='execution'))`;
    const where = `chain=? AND token=? AND time>=? AND time<=? AND ${population}`;
    const rows = this.db.prepare(`SELECT CAST(time / ? AS INTEGER) * ? t,
      SUM(CASE WHEN json_extract(body,'$.side')='buy' THEN COALESCE(json_extract(body,'$.usd'),0) ELSE 0 END) buyUsd,
      SUM(CASE WHEN json_extract(body,'$.side')='sell' THEN COALESCE(json_extract(body,'$.usd'),0) ELSE 0 END) sellUsd,
      SUM(json_extract(body,'$.side')='buy') buys, SUM(json_extract(body,'$.side')='sell') sells,
      SUM(json_extract(body,'$.side')='buy' AND json_extract(body,'$.usd') IS NULL) unpricedBuys,
      SUM(json_extract(body,'$.side')='sell' AND json_extract(body,'$.usd') IS NULL) unpricedSells
      FROM trades WHERE ${where} GROUP BY t ORDER BY t`).all(intervalMs,intervalMs,chain,token,from,to) as FlowBucket[];
    let cvd=0;
    const bars=rows.map(row=>{const delta=row.buyUsd-row.sellUsd;cvd+=delta;return {...row,delta,cvd};});
    const capturedPools=(this.db.prepare(`SELECT COUNT(DISTINCT pair) n FROM trades WHERE ${where}`).get(chain,token,from,to) as {n:number}).n;
    const knownPools=(this.db.prepare("SELECT COUNT(*) n FROM pairs WHERE chain=? AND token=?").get(chain,token) as {n:number}).n;
    // Where this exact population's capture begins, over all time rather than the requested range: a caller asking for
    // a window that starts before it must be able to say so instead of drawing the empty part as covered and flat.
    const firstPrintAt=(this.db.prepare(`SELECT MIN(time) n FROM trades WHERE chain=? AND token=? AND ${population}`).get(chain,token) as {n:number|null}).n;
    return {chain,token,from,to,intervalMs,observedAt:Date.now(),bars,buyUsd:rows.reduce((n,r)=>n+r.buyUsd,0),sellUsd:rows.reduce((n,r)=>n+r.sellUsd,0),delta:cvd,trades:rows.reduce((n,r)=>n+r.buys+r.sells,0),unpriced:rows.reduce((n,r)=>n+r.unpricedBuys+r.unpricedSells,0),capturedPools,knownPools,firstPrintAt,coverage:'captured-only'};
  }
  /**
   * Distinct wallets seen trading on a chain. `wallet` lives inside the stored body, so this is a full table scan —
   * 392 ms over 105,830 rows when measured on 2026-09-08 — and the result is memoized for `ttlMs` accordingly.
   */
  wallets(chain: Chain, now = Date.now(), ttlMs = 300_000): string[] {
    const cached = this.walletCache.get(chain);
    if (cached && now - cached.at < ttlMs) return cached.wallets;
    const rows = this.db.prepare("SELECT DISTINCT json_extract(body,'$.wallet') w FROM trades WHERE chain=? AND json_extract(body,'$.wallet') IS NOT NULL").all(chain) as Array<{w: string}>;
    const wallets = rows.map(row => row.w);
    this.walletCache.set(chain, { at: now, wallets });
    return wallets;
  }
  close() { this.db.close(); }
}
