import type { AlertsRouteDeps } from "../routes/alerts.js";
import { getLaunchService } from "../launch/service.js";
import { DEFAULT_FILL_RING } from "../traders/book.js";
import { getTraderService } from "../traders/service.js";
import { AlertEngine, type AlertEngineDeps } from "./engine.js";
import { alertSink } from "./sink.js";

let engine: AlertEngine | null = null;

/**
 * Live deps: the launch index for rows/symbols, the trader book for "per the book" questions, TraderService.coverage()
 * for the coverage stamp. Only reached from sink events (the launch service is running by then) and from the route.
 */
function liveEngineDeps(): AlertEngineDeps {
  const traders = getTraderService();
  return {
    launchOf: (chain, token) => getLaunchService().index.get(chain, token),
    walletTokenFills: (chain, wallet, token) => traders.book.fillsOf(chain, wallet).filter((fill) => fill.token === token).length,
    fomoFillsOf: (chain, token) => traders.book.tape(chain, DEFAULT_FILL_RING, { kind: "fomo", token }).length,
    oldestFillAt: () => traders.book.oldestFillAt(),
    coverage: () => traders.coverage(),
    symbolOf: (chain, token) => getLaunchService().index.get(chain, token)?.symbol ?? (chain === "robinhood" ? (traders.erc20Meta.get(token)?.symbol ?? null) : null),
    now: () => Date.now()
  };
}

/** Process-wide engine, subscribed to the sink on first call; the router factory calls this at mount so no event is missed. */
export function getAlertEngine(): AlertEngine {
  if (engine) return engine;
  const created = new AlertEngine(liveEngineDeps());
  alertSink.subscribe((event) => void created.handle(event));
  engine = created;
  return created;
}

export function liveAlertsRouteDeps(): AlertsRouteDeps {
  const traders = getTraderService();
  return { engine: getAlertEngine(), coverage: () => traders.coverage(), now: () => Date.now() };
}
