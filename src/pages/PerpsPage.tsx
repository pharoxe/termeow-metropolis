import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Candle, PublicConfig } from "../types";
import { PerpTradeTicket } from "../components/PerpTradeTicket";
import { MarketChart, type IndicatorSet } from "../components/MarketChart";
import { IndicatorBar } from "../components/IndicatorBar";
import { money, pct } from "../lib/format";

type Row = Record<string, unknown>;
const indicatorDefaults: IndicatorSet = { ema: true, bollinger: false, vwap: false, sr: true, volume: true, rsi: false, macd: false, obv: false };
function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item && typeof item === "object")) : []; }

export function PerpsPage({ config }: { config: PublicConfig }) {
  const [symbol, setSymbol] = useState("SOL-PERP");
  const [markets, setMarkets] = useState<Row[]>([]);
  const [marketResult, setMarketResult] = useState<Row>({});
  const [account, setAccount] = useState<Row>({});
  const [error, setError] = useState("");
  const [indicators, setIndicators] = useState(indicatorDefaults);

  useEffect(() => {
    api.perpsMarkets().then((result) => setMarkets(array(object(object(result).data).markets))).catch(() => undefined);
  }, []);
  useEffect(() => {
    setError("");
    Promise.allSettled([api.perpMarket(symbol), api.perpAccount()]).then(([marketState, accountState]) => {
      if (marketState.status === "fulfilled") setMarketResult(marketState.value);
      else setError(marketState.reason instanceof Error ? marketState.reason.message : String(marketState.reason));
      if (accountState.status === "fulfilled") setAccount(accountState.value);
    });
  }, [symbol]);

  const data = object(marketResult.data);
  const market = object(data.market);
  const price = object(data.priceSummary);
  const trend = object(data.priceTrend);
  const fees = object(market.fees);
  const funding = object(market.funding);
  const candles = useMemo(() => array(data.candles).map((item): Candle => ({
    time: Number(item.time), open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close), volume: Number(item.volume)
  })).filter((item) => Object.values(item).every(Number.isFinite)), [data.candles]);
  const orderbook = object(data.orderbook);
  const bids = array(orderbook.bids);
  const asks = array(orderbook.asks);
  const accountData = object(account.data);

  return (
    <main className="perps-desk">
      <div className="desk-strip"><b>PHOENIX</b><span>{markets.length || "—"} MARKETS</span><span>MARK <i>{money(Number(price.mark || data.markPrice))}</i></span><span>SPREAD <i>{Number(price.spreadBps).toFixed(2)} BPS</i></span><span>TREND <i className={Number(trend.changePct) < 0 ? "dn" : "up"}>{pct(Number(trend.changePct))}</i></span><span>MAX LEVERAGE <i>{String(market.maxLeverage || "—")}×</i></span></div>
      <div className="perps-desk-grid">
        <section className="panel perp-markets">
          <div className="ph"><span className="pt">PERP MARKETS</span><span className="pm">PHOENIX · CLAWPUMP</span></div>
          <div className="panel-scroll"><table className="terminal-table"><thead><tr><th>MARKET</th><th className="r">MAX LEV</th><th className="r">TAKER</th></tr></thead><tbody>{markets.slice(0, 76).map((item) => <tr className={String(item.perpSymbol) === symbol ? "selected" : ""} key={String(item.perpSymbol)} onClick={() => setSymbol(String(item.perpSymbol))}><td><b>{String(item.perpSymbol)}</b><small>{String(item.displayName || item.category)}</small></td><td className="r">{String(item.maxLeverage || "—")}×</td><td className="r">{(Number(object(item.fees).taker) * 100).toFixed(3)}%</td></tr>)}</tbody></table></div>
        </section>
        <section className="panel perp-chart">
          <div className="ph"><span className="pt">{symbol}</span><span className="chart-price">{money(Number(price.mark || data.markPrice))} <i className={Number(trend.changePct) < 0 ? "dn" : "up"}>{pct(Number(trend.changePct))}</i></span><span className="pm">1H · {candles.length} BARS</span></div>
          <IndicatorBar value={indicators} onChange={setIndicators} />
          {candles.length ? <MarketChart candles={candles} indicators={indicators} /> : <div className="integration-empty"><h2>PHOENIX DATA UNAVAILABLE</h2><p>{error || "Waiting for market candles."}</p></div>}
        </section>
        <aside className="perp-rail">
          <section className="panel perp-risk">
            <div className="ph"><span className="pt">MARKET RISK</span><span className="pm">LIVE CONFIG</span></div>
            <dl>
              <div><dt>MARK / MID</dt><dd>{money(Number(price.mark || data.markPrice))} / {money(Number(price.orderbookMid))}</dd></div>
              <div><dt>SPREAD</dt><dd>{Number(price.spreadBps).toFixed(2)} BPS</dd></div>
              <div><dt>RANGE HIGH / LOW</dt><dd>{money(Number(trend.high))} / {money(Number(trend.low))}</dd></div>
              <div><dt>MAKER / TAKER</dt><dd>{(Number(fees.maker) * 100).toFixed(3)}% / {(Number(fees.taker) * 100).toFixed(3)}%</dd></div>
              <div><dt>MAX FUND / H</dt><dd>{Number.isFinite(Number(funding.maxRatePerIntervalPercentage)) ? `${Number(funding.maxRatePerIntervalPercentage).toFixed(4)}%` : "—"}</dd></div>
              <div><dt>OI CAP LOTS</dt><dd>{String(market.openInterestCapBaseLots || "—")}</dd></div>
            </dl>
          </section>
          <PerpTradeTicket config={config} symbol={symbol} />
          <section className="panel account-board"><div className="ph"><span className="pt">AGENT ACCOUNT</span><span className="pm">READ ONLY</span></div><pre>{Object.keys(accountData).length ? JSON.stringify(accountData, null, 2) : "No initialized Phoenix account state returned."}</pre></section>
        </aside>
        <section className="panel orderbook-panel">
          <div className="ph"><span className="pt">ORDER BOOK</span><span className="pm">RESTING · CANCELLABLE</span></div>
          <div className="book-split"><div><b className="up">BIDS · PRICE / QTY</b>{bids.slice(0, 12).map((row, index) => <p key={index}><span>{String(row.price ?? row[0] ?? "—")}</span><b>{String(row.quantity ?? row.size ?? row[1] ?? "—")}</b></p>)}</div><div><b className="dn">ASKS · PRICE / QTY</b>{asks.slice(0, 12).map((row, index) => <p key={index}><span>{String(row.price ?? row[0] ?? "—")}</span><b>{String(row.quantity ?? row.size ?? row[1] ?? "—")}</b></p>)}</div></div>
          {!bids.length && !asks.length && <p className="empty-copy">Order-book levels were not returned in this response.</p>}
        </section>
        <section className="panel perps-method">
          <div className="ph"><span className="pt">CONTRACT · FUNDING · LIQUIDATION</span><span className="pm">PHOENIX ISOLATED PERPS</span></div>
          <div className="radar-grid">
            <div><small>MARKET PUBKEY</small><strong title={String(market.marketPubkey)}>{String(market.marketPubkey || "—")}</strong></div>
            <div><small>ASSET ID</small><strong>{String(market.assetId ?? "—")}</strong></div>
            <div><small>BASE LOT DECIMALS</small><strong>{String(market.baseLotsDecimals ?? "—")}</strong></div>
            <div><small>MAX LIQ SIZE LOTS</small><strong>{String(market.maxLiquidationSizeBaseLots || "—")}</strong></div>
          </div>
        </section>
      </div>
    </main>
  );
}
