import type { FomoMarker } from "./fomoMarkers";
import { walletLabel } from "./fomoPanel";
import { money } from "./format";

/** Pure view model for the FOMO hover strip under the chart legend. No React, tested in node. */

export type FomoHoverRow = {
  /** Handle from the population or the short address; never invented. */
  label: string;
  side: "buy" | "sell";
  /** "$1.2K", "×3 $1.2K", or "unpriced" (with " (+1 unpriced)" when a wallet mixes priced and unpriced fills). */
  amount: string;
  seeded: boolean;
};

export type FomoHoverView = {
  /** Bucket texts joined, buy first: "3 FOMO buys · $1.2K | 1 FOMO sell". */
  title: string;
  rows: FomoHoverRow[];
  /** Rows beyond `maxRows` that were not rendered. */
  more: number;
};

export const DEFAULT_HOVER_ROWS = 8;

function amountLabel(wallet: FomoMarker["wallets"][number]): string {
  const count = wallet.count > 1 ? `×${wallet.count} ` : "";
  if (wallet.usd == null) return `${count}unpriced`.trim();
  const tail = wallet.unpriced > 0 ? ` (+${wallet.unpriced} unpriced)` : "";
  return `${count}${money(wallet.usd, true)}${tail}`;
}

function usdRank(usd: number | null): number {
  return usd == null ? -1 : usd;
}

/** Rows across every bucket on the candle, largest priced first (unpriced last); null when the candle has no FOMO fills. */
export function fomoHoverView(markers: readonly FomoMarker[], maxRows = DEFAULT_HOVER_ROWS): FomoHoverView | null {
  if (markers.length === 0) return null;
  const rows = markers
    .flatMap((marker) => marker.wallets.map((wallet) => ({ wallet, side: marker.side })))
    .sort((a, b) => usdRank(b.wallet.usd) - usdRank(a.wallet.usd) || b.wallet.count - a.wallet.count)
    .map(({ wallet, side }): FomoHoverRow => ({
      label: walletLabel(wallet.address, wallet.handle),
      side,
      amount: amountLabel(wallet),
      seeded: wallet.kind === "seeded"
    }));
  const shown = rows.slice(0, Math.max(0, maxRows));
  return { title: markers.map((marker) => marker.text).join(" | "), rows: shown, more: rows.length - shown.length };
}
