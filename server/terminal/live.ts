import { mapKnownAttribution } from "./attribution.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Chain, PairRow } from "../../shared/wire.js";
import { flowCollector } from "../flow/collector.js";
import { getTraderService } from "../traders/service.js";
import { TradeArchive } from "./archive.js";

const directory = path.resolve(process.env.TERMINAL_DATA_DIR || "data/terminal");
mkdirSync(directory, {recursive: true});
export const tradeArchive = new TradeArchive(path.join(directory, "trades.db"));
flowCollector.ledger.observe(prints => tradeArchive.ingest(prints.map(print=>mapKnownAttribution(print,getTraderService()))));
getTraderService().fomoLedger.observe(prints => {
  for (const print of prints) tradeArchive.ingest([print], print.pair.startsWith("fomo:") ? print.pair.slice(5) : undefined);
});
export function bindArchive(chain: Chain, token: string, pairs: PairRow[]) {
  tradeArchive.bind(chain, token, pairs);
  for (const pair of pairs) {
    tradeArchive.ingest(flowCollector.ledger.recentPrints(chain, pair.pairAddress).map(print=>mapKnownAttribution(print,getTraderService())));
    tradeArchive.ingest(getTraderService().fomoLedger.recentPrints(chain, pair.pairAddress), token, pair.dex);
  }
  for (const fill of getTraderService().fillsForToken(chain, token, 2000)) tradeArchive.ingest([{...fill, source:"own"}], token, fill.dex);
}
