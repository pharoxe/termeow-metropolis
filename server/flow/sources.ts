import type { SourceChip } from "../../shared/wire.js";

export type SourceHealthLike = { lastOkAt: number | null; lastError: string | null };

/** Structural view of FlowCollector.status().sources; the own tape carries `prints`. */
export type SourcesLike = {
  geckoterminal: SourceHealthLike;
  own: SourceHealthLike & { tape: { prints: number } | null };
};

function chip(name: SourceChip["name"], health: SourceHealthLike): SourceChip {
  return { name, lastOkAt: health.lastOkAt, lastError: health.lastError };
}

/** Condenses collector source health into wire chips; own.prints appears only when the tape reports it. */
export function sourceChips(sources: SourcesLike): SourceChip[] {
  const own = chip("own", sources.own);
  return [
    chip("geckoterminal", sources.geckoterminal),
    sources.own.tape ? { ...own, prints: sources.own.tape.prints } : own
  ];
}
