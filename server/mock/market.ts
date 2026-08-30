import type { Candle, OnchainMarket } from "../types.js";

function seededCandles(price: number): Candle[] {
  const rows: Candle[] = [];
  let close = price;
  const now = Math.floor(Date.now() / 300_000) * 300_000;
  for (let i = 199; i >= 0; i -= 1) {
    const wave = Math.sin((200 - i) / 8) * 0.009 + Math.cos((200 - i) / 19) * 0.006;
    const open = close;
    close = Math.max(price * 0.5, open * (1 + wave / 10));
    rows.push({
      time: now - i * 300_000,
      open,
      high: Math.max(open, close) * 1.0035,
      low: Math.min(open, close) * 0.9965,
      close,
      volume: 25_000 + ((200 - i) % 17) * 8_300
    });
  }
  return rows;
}

export function mockAnsemMarket(mint: string, price = 0.00184): OnchainMarket {
  return {
    instrumentId: `solana:${mint}:spot`,
    mint,
    symbol: "ANSEM",
    name: "Ansem",
    quoteSymbol: "USD",
    priceUsd: price,
    change24hPct: 4.27,
    volume24hUsd: 1_420_000,
    liquidityUsd: 482_000,
    marketCapUsd: 1_840_000,
    fdvUsd: 1_840_000,
    pairAddress: null,
    dex: "ClawPump / Jupiter",
    observedAt: Date.now(),
    source: "demo fallback",
    degraded: true,
    notes: ["ClawPump credentials are not configured; demo candles are clearly marked and cannot be traded."],
    provider: null,
    candles: seededCandles(price),
    signals: [
      { label: "MOMENTUM", value: "warming", tone: "neutral" },
      { label: "LIQUIDITY", value: "$482K", tone: "neutral" },
      { label: "AUTHORITY", value: "verify live", tone: "neutral" }
    ]
  };
}
