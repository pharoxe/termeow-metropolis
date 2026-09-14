import { DatabaseSync } from "node:sqlite";
import type { Chain, LaunchRow } from "../../shared/wire.js";
import type { IndexedToken, TokenIndexSource, TokenResolution } from "../../shared/tokenIndex.js";

const normalize = (value: string) => value.trim().replace(/^\$+/, "").toLowerCase();
const addressKey = (chain: Chain, address: string) => chain === "robinhood" ? address.toLowerCase() : address;

type TokenInput = Omit<IndexedToken, "aliases" | "observedAt"> & { aliases?: string[]; observedAt?: number };
type TokenRow = { chain: Chain; address: string; symbol: string; name: string | null; imageUrl: string | null; aliases: string; source: TokenIndexSource; priority: number; observedAt: number; verified: number; verificationSource: string | null };

const decode = (row: TokenRow): IndexedToken => ({
  chain: row.chain,
  address: row.address,
  symbol: row.symbol,
  name: row.name ?? undefined,
  imageUrl: row.imageUrl ?? undefined,
  aliases: JSON.parse(row.aliases) as string[],
  source: row.source,
  priority: row.priority,
  observedAt: row.observedAt,
  verified: Boolean(row.verified),
  verificationSource: row.verificationSource ?? undefined
});

/** Local ticker-to-contract gateway. Like the Fomo identity registry, clients never spend upstream credits. */
export class TokenRegistry {
  private db: DatabaseSync;
  readonly persistent: boolean;

  constructor(file: string) {
    let db: DatabaseSync;
    let persistent = true;
    try {
      db = new DatabaseSync(file);
      db.exec("PRAGMA journal_mode=WAL;");
    } catch (error) {
      // Token discovery must not take the app down when a mounted cache volume is full.
      // Canonical seeds and the live launch index can safely rebuild this derived catalog.
      try { db!.close(); } catch { /* the failed handle may never have opened */ }
      console.warn(`token index: persistent store unavailable; rebuilding in memory (${error instanceof Error ? error.message : String(error)})`);
      db = new DatabaseSync(":memory:");
      persistent = false;
    }
    this.db = db;
    this.persistent = persistent;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_index(
        chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT, imageUrl TEXT,
        aliases TEXT NOT NULL, source TEXT NOT NULL, priority INTEGER NOT NULL, observedAt INTEGER NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0, verificationSource TEXT,
        PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS token_index_symbol ON token_index(symbol COLLATE NOCASE);
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(token_index)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("verified")) this.db.exec("ALTER TABLE token_index ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("verificationSource")) this.db.exec("ALTER TABLE token_index ADD COLUMN verificationSource TEXT");
  }

  upsert(input: TokenInput): IndexedToken {
    const address = addressKey(input.chain, input.address);
    const aliases = [...new Set([input.symbol, input.name, ...(input.aliases ?? [])].filter(Boolean).map((value) => normalize(String(value))))];
    const observedAt = input.observedAt ?? Date.now();
    const existing = this.byAddress(input.chain, address);
    if (existing && existing.priority > input.priority) return existing;
    this.db.prepare(`INSERT INTO token_index(chain,address,symbol,name,imageUrl,aliases,source,priority,observedAt,verified,verificationSource)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET
        symbol=excluded.symbol,name=COALESCE(excluded.name,token_index.name),imageUrl=COALESCE(excluded.imageUrl,token_index.imageUrl),
        aliases=excluded.aliases,source=excluded.source,priority=excluded.priority,observedAt=excluded.observedAt,
        verified=excluded.verified,verificationSource=COALESCE(excluded.verificationSource,token_index.verificationSource)`)
      .run(input.chain, address, input.symbol.replace(/^\$+/, "").toUpperCase(), input.name ?? null, input.imageUrl ?? null,
        JSON.stringify(aliases), input.source, input.priority, observedAt, Number(Boolean(input.verified)), input.verificationSource ?? null);
    return this.byAddress(input.chain, address)!;
  }

  ingestLaunches(rows: LaunchRow[]) {
    const upsert = this.db.prepare(`INSERT INTO token_index(chain,address,symbol,name,imageUrl,aliases,source,priority,observedAt,verified,verificationSource)
      VALUES(?,?,?,?,?,?,?,?,?,0,NULL) ON CONFLICT(chain,address) DO UPDATE SET
        symbol=excluded.symbol,name=COALESCE(excluded.name,token_index.name),imageUrl=COALESCE(excluded.imageUrl,token_index.imageUrl),
        aliases=excluded.aliases,source=excluded.source,priority=excluded.priority,observedAt=excluded.observedAt
      WHERE token_index.priority <= excluded.priority`);
    this.db.exec("BEGIN");
    try {
      for (const row of rows) if (row.symbol) {
        const symbol = row.symbol.replace(/^\$+/, "").toUpperCase();
        const aliases = [...new Set([symbol, row.name].filter(Boolean).map((value) => normalize(String(value))))];
        upsert.run(row.chain, addressKey(row.chain, row.token), symbol, row.name ?? null, row.image ?? null,
          JSON.stringify(aliases), "launch-index", 20, row.observedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  byAddress(chain: Chain, address: string): IndexedToken | null {
    const row = this.db.prepare("SELECT * FROM token_index WHERE chain=? AND address=?").get(chain, addressKey(chain, address)) as TokenRow | undefined;
    return row ? decode(row) : null;
  }

  resolve(query: string, chain?: Chain): TokenResolution {
    const key = normalize(query);
    const exactRows = this.db.prepare(`SELECT * FROM token_index
      WHERE (? IS NULL OR chain=?) AND (lower(symbol)=? OR lower(address)=? OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE lower(value)=?))
      ORDER BY priority DESC, observedAt DESC LIMIT 12`).all(chain ?? null, chain ?? null, key, key, key) as TokenRow[];
    const fuzzyRows = exactRows.length ? [] : this.db.prepare(`SELECT * FROM token_index
      WHERE (? IS NULL OR chain=?) AND (lower(symbol) LIKE ? OR lower(COALESCE(name,'')) LIKE ? OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE lower(value) LIKE ?))
      ORDER BY verified DESC, priority DESC, abs(length(symbol)-?), observedAt DESC LIMIT 8`)
      .all(chain ?? null, chain ?? null, `%${key}%`, `%${key}%`, `%${key}%`, key.length) as TokenRow[];
    const matches = (exactRows.length ? exactRows : fuzzyRows).map(decode);
    const top = matches[0] ?? null;
    const tied = top && exactRows.length ? matches.filter((item) => item.priority === top.priority) : [];
    return { query, indexed: exactRows.length > 0, match: tied.length === 1 ? top : null, matches, ambiguous: tied.length > 1 };
  }

  list(limit = 250) {
    return (this.db.prepare("SELECT * FROM token_index ORDER BY priority DESC, observedAt DESC LIMIT ?").all(limit) as TokenRow[]).map(decode);
  }

  close() { this.db.close(); }
}
