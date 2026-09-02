export type PoolTrade = {
  time: number;
  kind: "buy" | "sell";
  volumeUsd: number;
  txHash: string;
};

export type CvdPoint = { time: number; value: number };

export type CvdWindow = {
  trades: PoolTrade[];
  cvd: number | null;
  buyUsd: number;
  sellUsd: number;
  series: CvdPoint[];
  buyCount: number;
  sellCount: number;
  buyCountRecent: number;
  sellCountRecent: number;
  buyUsdRecent: number;
  sellUsdRecent: number;
  spanMs: number;
  flow: "buy" | "sell" | "flat";
};

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Window CVD: oldest→newest running sum of USD volume (buy +, sell −). */
export function computeCvd(trades: PoolTrade[]): CvdWindow {
  const sorted = [...trades].filter((trade) =>
    (trade.kind === "buy" || trade.kind === "sell")
    && Number.isFinite(trade.volumeUsd)
    && Number.isFinite(trade.time)
  ).sort((a, b) => a.time - b.time || a.txHash.localeCompare(b.txHash));

  const spanMs = sorted.length ? sorted[sorted.length - 1].time - sorted[0].time : 0;
  const lastTime = sorted.length ? sorted[sorted.length - 1].time : 0;
  const cutoff = spanMs < TWO_HOURS_MS ? Number.NEGATIVE_INFINITY : lastTime - TWO_HOURS_MS;

  let cvd = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let buyCount = 0;
  let sellCount = 0;
  let buyCountRecent = 0;
  let sellCountRecent = 0;
  let buyUsdRecent = 0;
  let sellUsdRecent = 0;
  const bySecond = new Map<number, number>();
  for (const trade of sorted) {
    const recent = trade.time >= cutoff;
    if (trade.kind === "buy") {
      cvd += trade.volumeUsd;
      buyUsd += trade.volumeUsd;
      buyCount += 1;
      if (recent) {
        buyCountRecent += 1;
        buyUsdRecent += trade.volumeUsd;
      }
    } else {
      cvd -= trade.volumeUsd;
      sellUsd += trade.volumeUsd;
      sellCount += 1;
      if (recent) {
        sellCountRecent += 1;
        sellUsdRecent += trade.volumeUsd;
      }
    }
    bySecond.set(Math.floor(trade.time / 1000) * 1000, cvd);
  }
  const series = [...bySecond.entries()]
    .map(([time, value]) => ({ time, value }))
    .sort((a, b) => a.time - b.time);

  const flow: CvdWindow["flow"] = buyUsdRecent === sellUsdRecent
    ? "flat"
    : buyUsdRecent > sellUsdRecent ? "buy" : "sell";

  return {
    trades: sorted,
    cvd: sorted.length ? cvd : null,
    buyUsd,
    sellUsd,
    series,
    buyCount,
    sellCount,
    buyCountRecent,
    sellCountRecent,
    buyUsdRecent,
    sellUsdRecent,
    spanMs,
    flow
  };
}
