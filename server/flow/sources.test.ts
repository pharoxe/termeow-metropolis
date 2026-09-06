import { describe, expect, it } from "vitest";
import { sourceChips } from "./sources.js";

const ok = { lastOkAt: 1000, lastError: null, lastErrorAt: null };
const bad = { lastOkAt: null, lastError: "429", lastErrorAt: 900 };

describe("sourceChips", () => {
  it("emits exactly pumpfun, geckoterminal, own in that order without the own print count when untracked", () => {
    expect(sourceChips({ pumpfun: ok, geckoterminal: bad, own: { ...bad, tape: null } })).toEqual([
      { name: "pumpfun", lastOkAt: 1000, lastError: null },
      { name: "geckoterminal", lastOkAt: null, lastError: "429" },
      { name: "own", lastOkAt: null, lastError: "429" }
    ]);
  });

  it("carries the own tape's print counter when the tape is present, dropping every other stat", () => {
    const chips = sourceChips({ pumpfun: ok, geckoterminal: ok, own: { ...ok, tape: { prints: 42, mints: 1 } as { prints: number } } });
    expect(chips[2]).toEqual({ name: "own", lastOkAt: 1000, lastError: null, prints: 42 });
    expect(chips).toHaveLength(3);
  });
});
