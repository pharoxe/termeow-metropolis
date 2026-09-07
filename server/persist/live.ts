import path from "node:path";
import { config } from "../config.js";
import { flowCollector } from "../flow/collector.js";
import { setLaunchServiceHook, type LaunchService } from "../launch/service.js";
import { setTraderServiceHook, type TraderService } from "../traders/service.js";
import {
  LEDGER_FOMO_PAIRS_CAP,
  LEDGER_GENERAL_PAIRS_CAP,
  erc20MetaComponent,
  launchIndexComponent,
  ledgerComponent,
  traderBookComponent,
  traderServiceComponent
} from "./components.js";
import { SnapshotManager, type SnapshotStatus } from "./snapshot.js";
import { configFingerprint } from "./store.js";

/**
 * Wires the manager to the process singletons. The launch and trader services are created lazily by their first
 * request, so their components restore from the creation hooks (launch: before start(), so the poller/enrichment see
 * the restored rows); the general flow ledger exists at import and restores at once. Market candles are not covered:
 * server/market/robinhood.ts exports no snapshot()/restore() in this tree.
 */
let manager: SnapshotManager | null = null;
let launch: LaunchService | null = null;
let traders: TraderService | null = null;

export function installSnapshots(): SnapshotManager {
  if (manager) return manager;
  const fingerprint = configFingerprint({ robinhoodRpcUrl: config.robinhood.rpcUrl, solanaRpcUrl: config.rpc.primary, nodeEnv: config.nodeEnv });
  const dir = path.resolve(process.cwd(), config.snapshot.dir);
  const live = new SnapshotManager({ dir, intervalMs: config.snapshot.intervalMs, fingerprint })
    .register(ledgerComponent("flow-ledger", () => flowCollector.ledger, LEDGER_GENERAL_PAIRS_CAP))
    .register(launchIndexComponent(() => launch?.index ?? null))
    .register(traderServiceComponent(() => traders))
    .register(traderBookComponent(() => traders?.book ?? null))
    .register(erc20MetaComponent(() => traders?.erc20Meta ?? null))
    .register(ledgerComponent("fomo-ledger", () => traders?.fomoLedger ?? null, LEDGER_FOMO_PAIRS_CAP));
  manager = live;
  live.restore("flow-ledger");
  setLaunchServiceHook((service) => {
    launch = service;
    live.restore("launch-index");
  });
  setTraderServiceHook((service) => {
    traders = service;
    for (const name of ["trader-population", "trader-book", "erc20-meta", "fomo-ledger"]) live.restore(name);
  });
  live.start();
  console.log(`snapshot: dir ${dir}, every ${config.snapshot.intervalMs} ms, fingerprint ${fingerprint}`);
  return live;
}

/** restoredAt / snapshotAge / snapshot detail for GET /api/health; empty when installSnapshots() never ran (tests). */
export function snapshotStatus(): SnapshotStatus | { restoredAt: null; snapshotAge: null } {
  return manager ? manager.status() : { restoredAt: null, snapshotAge: null };
}
