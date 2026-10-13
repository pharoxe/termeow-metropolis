import { describe, expect, it } from "vitest";
import { sourceChips } from "./sources.js";

const ok = { lastOkAt: 1000, lastError: null, lastErrorAt: null };
const bad = { lastOkAt: null, lastError: "429", lastErrorAt: 900 };

describe("sourceChips", () => {
  it("emits exactly geckoterminal, own in that order without the own print count when untracked", () => {
    expect(sourceChips({ geckoterminal: bad, own: { ...bad, tape: null } })).toEqual([
      { name: "geckoterminal", lastOkAt: null, lastError: "429" },
      { name: "own", lastOkAt: null, lastError: "429" }
    ]);
  });

  it("carries the own tape's print counter when the tape is present, dropping every other stat", () => {
    const chips = sourceChips({ geckoterminal: ok, own: { ...ok, tape: { prints: 42, mints: 1 } as { prints: number } } });
    expect(chips[1]).toEqual({ name: "own", lastOkAt: 1000, lastError: null, prints: 42 });
    expect(chips).toHaveLength(2);
  });
});
