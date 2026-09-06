import type { SourceChip } from "../../shared/wire.js";

export type SourceHealthLike = { lastOkAt: number | null; lastError: string | null };

/** Structural view of FlowCollector.status().sources; both own-tape stat shapes carry `prints`. */
export type SourcesLike = {
  pumpfun: SourceHealthLike;
  geckoterminal: SourceHealthLike;
  own: SourceHealthLike & { tape: { prints: number } | null };
};

function chip(name: SourceChip["name"], health: SourceHealthLike): SourceChip {
  return { name, lastOkAt: health.lastOkAt, lastError: health.lastError };
}

/** Condenses collector source health into three wire chips; own.prints appears only when the tape reports it. */
export function sourceChips(sources: SourcesLike): SourceChip[] {
  const own = chip("own", sources.own);
  return [
    chip("pumpfun", sources.pumpfun),
    chip("geckoterminal", sources.geckoterminal),
    sources.own.tape ? { ...own, prints: sources.own.tape.prints } : own
  ];
}
