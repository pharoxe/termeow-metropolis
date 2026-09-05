import type { Candle, OnchainMarket, PoolCvd } from "../types";
import { atr, stochRsi } from "./indicators";

type Row = Record<string, unknown>;

export type TradeCondition = {
  label: string;
  met: boolean;
};

export type AgentTradeSetup = {
  id: "conditional-reversal" | "range-confluence";
  option: "A" | "B";
  title: string;
  entryLabel: string;
  entryPrice: number;
  exitPrice: number | null;
  confidence: number;
  conditions: TradeCondition[];
  rationale: string;
};

export type AgenticAnalysis = {
  signal: "BUY WATCH" | "WAIT" | "RISK OFF";
  confidence: number;
  summary: string;
  stochK: number | null;
  stochD: number | null;
  cvdDelta: number | null;
  support: number;
  resistance: number;
  whaleSellRisk: boolean;
  setups: AgentTradeSetup[];
};

export type AgenticAnalysisInput = {
  market: OnchainMarket;
  candles: Candle[];
  cvd: Pick<PoolCvd, "buyUsdRecent" | "sellUsdRecent" | "flow"> | null;
  provider: unknown;
};

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function last(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] != null) return values[index];
  return null;
}

function previous(values: Array<number | null>) {
  let seen = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] == null) continue;
    seen += 1;
    if (seen === 2) return values[index];
  }
  return null;
}

function bounded(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function analyzeToken({ market, candles, cvd, provider }: AgenticAnalysisInput): AgenticAnalysis {
  const usable = candles.filter((candle) => Number.isFinite(candle.close) && candle.close > 0);
  const current = market.priceUsd || usable.at(-1)?.close || 0;
  const window = usable.slice(-96);
  const structure = window.length ? window : [{ time: 0, open: current, high: current, low: current, close: current, volume: 0 }];
  const closes = usable.map((candle) => candle.close);
  const stochastic = stochRsi(closes);
  const stochK = last(stochastic.k);
  const stochD = last(stochastic.d);
  const previousK = previous(stochastic.k);
  const previousD = previous(stochastic.d);
  const currentAtr = last(atr(usable)) || current * 0.02;
  const support = Math.min(...structure.map((candle) => candle.low));
  const resistance = Math.max(...structure.map((candle) => candle.high));
  const cvdDelta = cvd ? cvd.buyUsdRecent - cvd.sellUsdRecent : null;
  const positiveCvd = cvdDelta != null && cvdDelta > 0;
  const reversal = stochK != null && stochD != null && previousK != null && previousD != null
    && stochK > stochD && previousK <= previousD && stochK < 35;
  const oversold = stochK != null && stochK <= 25;
  const overbought = stochK != null && stochK >= 80;
  const providerRecord = record(provider);
  const intelligenceText = JSON.stringify([
    providerRecord.intelligence_signals,
    providerRecord.anomalies,
    providerRecord.intelligence_market,
    providerRecord.top_movers,
    providerRecord.holders
  ]).toLowerCase();
  const whaleSellRisk = /(whale.{0,35}(sell|exit|distribution))|((large|smart).{0,20}sell)/.test(intelligenceText);
  const sentiment = String(record(providerRecord.get_indicators).sentiment || "").toLowerCase();
  const bullishIntel = /(bull|positive|accumul)/.test(`${sentiment} ${intelligenceText.slice(0, 3500)}`);
  const liquidityHealthy = (market.liquidityUsd || 0) >= 100_000;
  const nearSupport = current > 0 && (current - support) / current <= 0.08;
  const triggerA = Math.max(support + currentAtr * 0.25, current - currentAtr * 1.25);
  const entryB = Math.max(support + currentAtr * 0.12, current - currentAtr * 1.75);
  const exitB = resistance > entryB ? resistance - currentAtr * 0.25 : current + currentAtr * 2;

  const optionAConditions: TradeCondition[] = [
    { label: `Price reaches reversal zone`, met: current <= triggerA },
    { label: "Stochastic RSI crosses up below 35", met: reversal },
    { label: "CVD turns positive", met: positiveCvd },
    { label: "Liquidity passes execution floor", met: liquidityHealthy }
  ];
  const optionBConditions: TradeCondition[] = [
    { label: "Stochastic RSI is at a local bottom", met: oversold },
    { label: "Positive CVD confluence", met: positiveCvd },
    { label: "Price is near local support", met: nearSupport },
    { label: "No whale distribution signal", met: !whaleSellRisk }
  ];
  const score = (conditions: TradeCondition[], bias = 0) => bounded(35 + conditions.filter((item) => item.met).length * 14 + bias);
  const confidenceA = score(optionAConditions, bullishIntel ? 5 : 0);
  const confidenceB = score(optionBConditions, bullishIntel ? 4 : 0);
  const riskOff = whaleSellRisk && (overbought || (cvdDelta != null && cvdDelta < 0));
  const signal = riskOff ? "RISK OFF" : (reversal && positiveCvd) || (oversold && positiveCvd && nearSupport) ? "BUY WATCH" : "WAIT";
  const confidence = riskOff ? bounded(55 + (overbought ? 15 : 0)) : Math.max(confidenceA, confidenceB);
  const flowPhrase = cvdDelta == null ? "CVD is still resolving" : positiveCvd ? "CVD confirms net buying" : "CVD is dominated by recent sells";
  const momentumPhrase = stochK == null ? "momentum is warming up" : stochK <= 25 ? "Stochastic RSI is in its lower range" : stochK >= 80 ? "Stochastic RSI is extended" : "Stochastic RSI is mid-range";
  const summary = `${market.symbol} is a ${signal.toLowerCase()} at the current structure: ${momentumPhrase}, ${flowPhrase}, and price is ${nearSupport ? "near" : "away from"} local support.${whaleSellRisk ? " Whale distribution risk is present." : " No whale sell alert is currently present."}`;

  return {
    signal,
    confidence,
    summary,
    stochK,
    stochD,
    cvdDelta,
    support,
    resistance,
    whaleSellRisk,
    setups: [
      {
        id: "conditional-reversal",
        option: "A",
        title: `Buy ${market.symbol} on confirmed reversal`,
        entryLabel: "Conditional entry",
        entryPrice: triggerA,
        exitPrice: null,
        confidence: confidenceA,
        conditions: optionAConditions,
        rationale: "Wait for price, momentum, and order flow to agree before entering. The setup stays inactive until every trigger is true."
      },
      {
        id: "range-confluence",
        option: "B",
        title: `Trade the ${market.symbol} momentum range`,
        entryLabel: "Local-bottom entry",
        entryPrice: entryB,
        exitPrice: exitB,
        confidence: confidenceB,
        conditions: optionBConditions,
        rationale: "Enter near the local Stochastic RSI floor with positive CVD, then exit near the momentum top or immediately on a whale sell signal."
      }
    ]
  };
}
