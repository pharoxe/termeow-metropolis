import { describe, expect, it } from "vitest";
import { coverageChipLabel } from "./flowSeries";
import type { FlowCoverage } from "../../shared/wire";

describe("coverageChipLabel", () => {
  it("formats pairs, volume share and tape fraction as rounded percentages", () => {
    const coverage: FlowCoverage = { fraction: 0.756, firstPrintAt: 1, volumeShare: 0.914, tierAPairs: 2, totalPairs: 5 };
    expect(coverageChipLabel(coverage)).toBe("AGG 2/5 pairs · 91% vol · tape 76%");
  });

  it("uses an em-dash when volume share is unknown", () => {
    const coverage: FlowCoverage = { fraction: 0, firstPrintAt: null, volumeShare: null, tierAPairs: 0, totalPairs: 0 };
    expect(coverageChipLabel(coverage)).toBe("AGG 0/0 pairs · — vol · tape 0%");
  });
});
