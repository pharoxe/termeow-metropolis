import type { FlowWindow } from "../../shared/wire";
import type { Candle, OnchainMarket } from "../types";
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
  /** buyUsd - sellUsd of the named Tier A flow window; null while no window has been measured. */
  netFlowUsd: number | null;
  /** Upper-case window label the flow figures came from (e.g. "1H"); null when no window was supplied. */
  flowWindow: string | null;
  support: number;
  resistance: number;
  whaleSellRisk: boolean;
  setups: AgentTradeSetup[];
};

/** Adapter over one Tier A flow window (from /api/flow/token `windows`); the label travels with the numbers. */
export type AnalysisFlow = { label: string; buyUsd: number; sellUsd: number };

export type AgenticAnalysisInput = {
  market: OnchainMarket;
  candles: Candle[];
  flow: AnalysisFlow | null;
  provider: unknown;
};

/** The named rolling window as the analysis input; null when the flow poll has not returned windows (never zeros). */
export function analysisFlowFromWindows(windows: FlowWindow[] | undefined, label: FlowWindow["label"] = "1h"): AnalysisFlow | null {
  const window = windows?.find((item) => item.label === label);
  return window ? { label: window.label, buyUsd: window.buyUsd, sellUsd: window.sellUsd } : null;
}

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

export function analyzeToken({ market, candles, flow, provider }: AgenticAnalysisInput): AgenticAnalysis {
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
  const netFlowUsd = flow ? flow.buyUsd - flow.sellUsd : null;
  const flowWindow = flow ? flow.label.toUpperCase() : null;
  const flowName = flowWindow ? `Net flow (${flowWindow})` : "Net flow";
  const positiveFlow = netFlowUsd != null && netFlowUsd > 0;
  const reversal = stochK != null && stochD != null && previousK != null && previousD != null
    && stochK > stochD && previousK <= previousD && stochK < 35;
  const oversold = stochK != null && stochK <= 25;
  const overbought = stochK != null && stochK >= 80;
  // Nansen flow intelligence for this token (GET /api/onchain/smart-money/:token/flows): cohort net USD flows.
  const flows = record(record(provider).data);
  const segmentFlow = (segment: string) => {
    const value = Number(record(flows[segment]).netFlowUsd);
    return Number.isFinite(value) ? value : null;
  };
  const smartFlow = segmentFlow("smart_trader");
  const whaleFlow = segmentFlow("whale");
  const topPnlFlow = segmentFlow("top_pnl");
  const hasDistributionData = smartFlow != null || whaleFlow != null || topPnlFlow != null;
  const whaleSellRisk = (whaleFlow != null && whaleFlow < 0) || (smartFlow != null && smartFlow < 0 && (topPnlFlow ?? 0) <= 0);
  const bullishIntel = (smartFlow ?? 0) > 0 || (topPnlFlow ?? 0) > 0;
  const liquidityHealthy = (market.liquidityUsd || 0) >= 100_000;
  const nearSupport = current > 0 && (current - support) / current <= 0.08;
  const triggerA = Math.max(support + currentAtr * 0.25, current - currentAtr * 1.25);
  const entryB = Math.max(support + currentAtr * 0.12, current - currentAtr * 1.75);
  const exitB = resistance > entryB ? resistance - currentAtr * 0.25 : current + currentAtr * 2;

  const optionAConditions: TradeCondition[] = [
    { label: `Price reaches reversal zone`, met: current <= triggerA },
    { label: "Stochastic RSI crosses up below 35", met: reversal },
    { label: `${flowName} turns positive`, met: positiveFlow },
    { label: "Liquidity passes execution floor", met: liquidityHealthy }
  ];
  const optionBConditions: TradeCondition[] = [
    { label: "Stochastic RSI is at a local bottom", met: oversold },
    { label: `Positive ${flowName.toLowerCase()} confluence`, met: positiveFlow },
    { label: "Price is near local support", met: nearSupport },
    { label: "Nansen smart-money / whale flow is not distributing", met: hasDistributionData && !whaleSellRisk }
  ];
  const score = (conditions: TradeCondition[], bias = 0) => bounded(35 + conditions.filter((item) => item.met).length * 14 + bias);
  const confidenceA = score(optionAConditions, bullishIntel ? 5 : 0);
  const confidenceB = score(optionBConditions, bullishIntel ? 4 : 0);
  const riskOff = whaleSellRisk && (overbought || (netFlowUsd != null && netFlowUsd < 0));
  const signal = riskOff ? "RISK OFF" : (reversal && positiveFlow) || (oversold && positiveFlow && nearSupport) ? "BUY WATCH" : "WAIT";
  const confidence = riskOff ? bounded(55 + (overbought ? 15 : 0)) : Math.max(confidenceA, confidenceB);
  const flowPhrase = netFlowUsd == null ? "Tier A flow is still resolving" : positiveFlow ? `Tier A net flow over the last ${flowWindow} confirms net buying` : `Tier A net flow over the last ${flowWindow} is dominated by sells`;
  const momentumPhrase = stochK == null ? "momentum is warming up" : stochK <= 25 ? "Stochastic RSI is in its lower range" : stochK >= 80 ? "Stochastic RSI is extended" : "Stochastic RSI is mid-range";
  const summary = `${market.symbol} is a ${signal.toLowerCase()} at the current structure: ${momentumPhrase}, ${flowPhrase}, and price is ${nearSupport ? "near" : "away from"} local support.${whaleSellRisk ? " Nansen shows whales or smart money distributing." : hasDistributionData ? " Nansen smart-money and whale flows are not distributing." : " Smart-money flow coverage is unavailable (Nansen not configured)."}`;

  return {
    signal,
    confidence,
    summary,
    stochK,
    stochD,
    netFlowUsd,
    flowWindow,
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
        rationale: `Enter near the local Stochastic RSI floor with positive ${flowName.toLowerCase()}, then exit near the momentum top or immediately on a whale sell signal.`
      }
    ]
  };
}
