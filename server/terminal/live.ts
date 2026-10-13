import { mapKnownAttribution } from "./attribution.js";
import { mkdirSync, statfsSync } from "node:fs";
import path from "node:path";
import type { Chain, PairRow } from "../../shared/wire.js";
import { flowCollector } from "../flow/collector.js";
import { getTraderService } from "../traders/service.js";
import { TradeArchive } from "./archive.js";

const directory = path.resolve(process.env.TERMINAL_DATA_DIR || "data/terminal");
mkdirSync(directory, {recursive: true});
let tradeArchivePath = path.join(directory, "trades.db");
if (process.env.NODE_ENV === "production" && directory.startsWith("/data/")) {
  try {
    const disk = statfsSync(directory);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (freeBytes < 32 * 1024 * 1024) {
      tradeArchivePath = ":memory:";
      console.warn("trade archive: volume nearly full; preserving existing archive and using temporary memory storage");
    }
  } catch { /* Persistence remains best-effort; TradeArchive has an in-memory fallback path elsewhere. */ }
}
export const tradeArchive = new TradeArchive(tradeArchivePath);
const archiveDays = Math.max(1, Number(process.env.TRADE_ARCHIVE_RETENTION_DAYS || 2));
const pruneArchive = () => {
  const now = Date.now();
  const result = tradeArchive.prune({ observations: now - 6 * 3_600_000, trades: now - archiveDays * 86_400_000 });
  if (result.observations || result.changes || result.trades) setTimeout(pruneArchive, 1000).unref();
};
setTimeout(pruneArchive, 10_000).unref();
flowCollector.ledger.observe(prints => tradeArchive.ingest(prints.map(print=>mapKnownAttribution(print,getTraderService()))));
getTraderService().smartLedger.observe(prints => {
  for (const print of prints) tradeArchive.ingest([print], print.pair.startsWith("smart:") ? print.pair.slice(5) : undefined);
});
export function bindArchive(chain: Chain, token: string, pairs: PairRow[]) {
  tradeArchive.bind(chain, token, pairs);
  for (const pair of pairs) {
    tradeArchive.ingest(flowCollector.ledger.recentPrints(chain, pair.pairAddress).map(print=>mapKnownAttribution(print,getTraderService())));
    tradeArchive.ingest(getTraderService().smartLedger.recentPrints(chain, pair.pairAddress), token, pair.dex);
  }
  for (const fill of getTraderService().fillsForToken(chain, token, 2000)) tradeArchive.ingest([{...fill, source:"own"}], token, fill.dex);
}
