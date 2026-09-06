import type { FlowCoverage } from "../../shared/wire";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function coverageChipLabel(coverage: FlowCoverage): string {
  const vol = coverage.volumeShare == null ? "—" : percent(coverage.volumeShare);
  return `AGG ${coverage.tierAPairs}/${coverage.totalPairs} pairs · ${vol} vol · tape ${percent(coverage.fraction)}`;
}
