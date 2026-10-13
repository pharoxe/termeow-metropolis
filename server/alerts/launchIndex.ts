import type { Chain, LaunchRow } from "../../shared/wire.js";
import { LaunchIndex, type LaunchIndexOptions, type LaunchUpsert } from "../launch/index.js";
import { hasChainLaunchSource } from "./rules.js";
import type { AlertSinkLike } from "./sink.js";

/**
 * The LaunchIndex the live LaunchService uses: identical storage, plus one sink call at the two chokepoints the
 * capture named. `launch` fires when a row first carries a chain source (rpc:monad / pumpportal) — on creation
 * or when an enrichment-born row is later confirmed on chain; rows known only through dexscreener never fire.
 * `graduation` fires once per applied recordGraduation (Pons emits LaunchSwept and PoolGraduated; the engine dedupes).
 */
export class AlertingLaunchIndex extends LaunchIndex {
  constructor(
    private readonly sink: AlertSinkLike,
    opts: LaunchIndexOptions = {}
  ) {
    super(opts);
  }

  override upsert(input: LaunchUpsert): LaunchRow {
    const before = this.get(input.chain, input.token);
    const row = super.upsert(input);
    if (!hasChainLaunchSource(before?.sources) && hasChainLaunchSource(row.sources)) this.sink.launch(row);
    return row;
  }

  override recordGraduation(chain: Chain, token: string, at: number, pool: string | null): boolean {
    const applied = super.recordGraduation(chain, token, at, pool);
    if (applied) {
      const row = this.get(chain, token);
      if (row) this.sink.graduation(row, at);
    }
    return applied;
  }
}
