import { DatabaseSync } from "node:sqlite";
import type { Chain, LaunchRow } from "../../shared/wire.js";
import type { IndexedToken, TokenIndexSource, TokenResolution } from "../../shared/tokenIndex.js";

const normalize = (value: string) => value.trim().replace(/^\$+/, "").toLowerCase();
const addressKey = (chain: Chain, address: string) => chain === "robinhood" ? address.toLowerCase() : address;

type TokenInput = Omit<IndexedToken, "aliases" | "observedAt"> & { aliases?: string[]; observedAt?: number };
type TokenRow = { chain: Chain; address: string; symbol: string; name: string | null; imageUrl: string | null; aliases: string; source: TokenIndexSource; priority: number; observedAt: number };

const decode = (row: TokenRow): IndexedToken => ({
  chain: row.chain,
  address: row.address,
  symbol: row.symbol,
  name: row.name ?? undefined,
  imageUrl: row.imageUrl ?? undefined,
  aliases: JSON.parse(row.aliases) as string[],
  source: row.source,
  priority: row.priority,
  observedAt: row.observedAt
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
        PRIMARY KEY(chain,address));
      CREATE INDEX IF NOT EXISTS token_index_symbol ON token_index(symbol COLLATE NOCASE);
    `);
  }

  upsert(input: TokenInput): IndexedToken {
    const address = addressKey(input.chain, input.address);
    const aliases = [...new Set([input.symbol, input.name, ...(input.aliases ?? [])].filter(Boolean).map((value) => normalize(String(value))))];
    const observedAt = input.observedAt ?? Date.now();
    const existing = this.byAddress(input.chain, address);
    if (existing && existing.priority > input.priority) return existing;
    this.db.prepare(`INSERT INTO token_index(chain,address,symbol,name,imageUrl,aliases,source,priority,observedAt)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET
        symbol=excluded.symbol,name=COALESCE(excluded.name,token_index.name),imageUrl=COALESCE(excluded.imageUrl,token_index.imageUrl),
        aliases=excluded.aliases,source=excluded.source,priority=excluded.priority,observedAt=excluded.observedAt`)
      .run(input.chain, address, input.symbol.replace(/^\$+/, "").toUpperCase(), input.name ?? null, input.imageUrl ?? null,
        JSON.stringify(aliases), input.source, input.priority, observedAt);
    return this.byAddress(input.chain, address)!;
  }

  ingestLaunches(rows: LaunchRow[]) {
    for (const row of rows) if (row.symbol) this.upsert({
      chain: row.chain, address: row.token, symbol: row.symbol, name: row.name ?? undefined,
      imageUrl: row.image ?? undefined, aliases: row.name ? [row.name] : [], source: "launch-index", priority: 20,
      observedAt: row.observedAt
    });
  }

  byAddress(chain: Chain, address: string): IndexedToken | null {
    const row = this.db.prepare("SELECT * FROM token_index WHERE chain=? AND address=?").get(chain, addressKey(chain, address)) as TokenRow | undefined;
    return row ? decode(row) : null;
  }

  resolve(query: string, chain?: Chain): TokenResolution {
    const key = normalize(query);
    const rows = this.db.prepare(`SELECT * FROM token_index
      WHERE (? IS NULL OR chain=?) AND (lower(symbol)=? OR lower(address)=? OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE lower(value)=?))
      ORDER BY priority DESC, observedAt DESC LIMIT 12`).all(chain ?? null, chain ?? null, key, key, key) as TokenRow[];
    const matches = rows.map(decode);
    const top = matches[0] ?? null;
    const tied = top ? matches.filter((item) => item.priority === top.priority) : [];
    return { query, indexed: matches.length > 0, match: tied.length === 1 ? top : null, matches, ambiguous: tied.length > 1 };
  }

  list(limit = 250) {
    return (this.db.prepare("SELECT * FROM token_index ORDER BY priority DESC, observedAt DESC LIMIT ?").all(limit) as TokenRow[]).map(decode);
  }

  close() { this.db.close(); }
}
