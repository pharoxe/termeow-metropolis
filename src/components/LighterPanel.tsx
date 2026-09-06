import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../api/client";
import type { LighterBook, LighterFlowResponse, LighterMarket, LighterTradesResponse } from "../../shared/wire";
import { windowRow } from "../lib/flowPanel";
import { EM_DASH, LADDER_DEPTH, TAPE_LIMIT, bookSourceLabel, buildLadder, cvdLine, fmtBps, fmtNum, fundingLine, marketRow, sortMarketsByVolume, tapeRows, type LadderRow } from "../lib/lighterPanel";

const BOOK_MS = 2_000;
const TRADES_MS = 3_000;
const FLOW_MS = 10_000;
const MARKETS_MS = 30_000;
const WINDOW_COLUMNS = ["WINDOW", "BUY", "SELL", "NET", "PRINTS", "AGGR"];

type Polled<T> = { data: T | null; error: string | null };

/** Polls `load` every `ms` while mounted; a stale response never lands after unmount or a key change. */
function usePolled<T>(load: () => Promise<T>, ms: number, key: unknown): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null });
  useEffect(() => {
    let active = true;
    setState({ data: null, error: null });
    const tick = async () => {
      try {
        const data = await load();
        if (active) setState({ data, error: null });
      } catch (error) {
        if (active) setState((current) => ({ data: current.data, error: error instanceof Error ? error.message : String(error) }));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), ms);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return state;
}

function LadderRows({ rows, tone, decimals }: { rows: LadderRow[]; tone: "ask" | "bid"; decimals: { price: number; size: number } }) {
  return (
    <>
      {rows.map((row) => (
        <tr className={tone} key={row.price}>
          <td className="bar"><i style={{ width: `${row.pct}%` }} /><span>{fmtNum(row.price, decimals.price)}</span></td>
          <td className="r">{fmtNum(row.size, decimals.size)}</td>
          <td className="r">{fmtNum(row.total, decimals.size)}</td>
        </tr>
      ))}
    </>
  );
}

function Ladder({ book, decimals }: { book: LighterBook | null; decimals: { price: number; size: number } }) {
  const ladder = buildLadder(book, LADDER_DEPTH);
  if (!ladder.asks.length && !ladder.bids.length) return <p className="empty-copy">{book?.error ? `No book: ${book.error}` : "Waiting for the first book snapshot."}</p>;
  return (
    <table>
      <thead><tr><th>PRICE</th><th className="r">SIZE</th><th className="r">TOTAL</th></tr></thead>
      <tbody>
        <LadderRows rows={ladder.asks} tone="ask" decimals={decimals} />
        <tr className="spread"><td colSpan={3}>MID {fmtNum(book?.mid ?? null, decimals.price)} · SPREAD {fmtBps(book?.spreadBps)}</td></tr>
        <LadderRows rows={ladder.bids} tone="bid" decimals={decimals} />
      </tbody>
    </table>
  );
}

function Tape({ trades, decimals, now }: { trades: LighterTradesResponse | null; decimals: { price: number; size: number }; now: number }) {
  const rows = tapeRows(trades?.trades ?? [], now, decimals.price, decimals.size, TAPE_LIMIT);
  if (!rows.length) return <p className="empty-copy">{trades?.error ? `No tape: ${trades.error}` : "No trades yet."}</p>;
  return (
    <>
      {rows.map((row) => (
        <p className={`tape-row ${row.tone}`} key={row.key}>
          <span>{row.side}</span>
          <b>{row.price} × {row.size}</b>
          {row.liq && <i title="Liquidation">LIQ</i>}
          <em>{row.usd} · {row.age}</em>
        </p>
      ))}
    </>
  );
}

function Windows({ flow }: { flow: LighterFlowResponse | null }) {
  const windows = flow?.windows ?? [];
  if (!windows.length) return <p className="empty-copy">{flow?.error ? `No flow: ${flow.error}` : "No taker-side windows in the ledger yet."}</p>;
  return (
    <table className="terminal-table flow-windows">
      <thead><tr>{WINDOW_COLUMNS.map((column, index) => <th key={column} className={index ? "r" : ""}>{column}</th>)}</tr></thead>
      <tbody>
        {windows.map((window) => {
          const row = windowRow(window);
          return (
            <tr className="static" key={row.label}>
              <td>{row.label}</td>
              <td className="r up">{row.buy}</td>
              <td className="r dn">{row.sell}</td>
              <td className={`r ${row.netTone}`}>{row.net}</td>
              <td className="r">{row.prints}</td>
              <td className="r">{row.aggr}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Lighter market view rendered inside the chart panel: header line, 10-level ladder, taker tape, taker-side windows, CVD readout. */
export function LighterPanel({ marketId, symbol }: { marketId: number; symbol: string }) {
  const book = usePolled(() => api.lighterBook(marketId, LADDER_DEPTH), BOOK_MS, marketId);
  const trades = usePolled(() => api.lighterTrades(marketId, TAPE_LIMIT), TRADES_MS, marketId);
  const flow = usePolled(() => api.lighterFlow(marketId, "1m"), FLOW_MS, marketId);
  const markets = usePolled(() => api.lighterMarkets(), MARKETS_MS, "markets");
  const market = markets.data?.markets.find((row) => row.marketId === marketId) ?? null;
  const decimals = { price: market?.priceDecimals ?? 2, size: market?.sizeDecimals ?? 4 };
  const now = Date.now();
  const stale = Boolean(book.data?.stale || trades.data?.stale || flow.data?.stale || markets.data?.stale);
  return (
    <div className="lighter-panel" data-market={marketId}>
      <div className="lighter-head">
        <span>MARK <b>{fmtNum(market?.markPrice, decimals.price)}</b></span>
        <span>INDEX <b>{fmtNum(market?.indexPrice, decimals.price)}</b></span>
        <span>LAST <b>{fmtNum(market?.lastPrice, decimals.price)}</b></span>
        <span>{fundingLine(flow.data?.funding)}</span>
        <span className="chip">{bookSourceLabel(book.data)}</span>
        {stale && <span className="chip warn">STALE</span>}
        {(book.error || trades.error || flow.error) && <span className="chip warn" title={book.error || trades.error || flow.error || ""}>FETCH ERROR</span>}
        <span className="pm">{symbol} · MARKET {marketId} · {market ? market.status.toUpperCase() : EM_DASH}</span>
      </div>
      <div className="lighter-book"><Ladder book={book.data} decimals={decimals} /></div>
      <div className="lighter-tape">
        <p className="pm">TAPE · LAST {TAPE_LIMIT} · {trades.data?.population ?? "LIGHTER · TAKER SIDE"}</p>
        <Tape trades={trades.data} decimals={decimals} now={now} />
      </div>
      <div className="lighter-flow">
        <p className="pm">LIGHTER · TAKER SIDE · 1M LEDGER</p>
        <Windows flow={flow.data} />
        <p className="lighter-cvd">{cvdLine(flow.data?.bars)}</p>
      </div>
    </div>
  );
}

/** WatchPanel tab body: all Lighter perp markets sorted by 24h volume; polls the cached /markets route. */
export function LighterMarketsTable({ selected, onPick }: { selected: number | null; onPick?: (marketId: number, symbol: string) => void }) {
  const markets = usePolled(() => api.lighterMarkets(), MARKETS_MS, "markets");
  const rows = sortMarketsByVolume(markets.data?.markets ?? []);
  if (!rows.length) return <p className="empty-copy">{markets.error || markets.data?.error ? `Lighter markets unavailable: ${markets.error || markets.data?.error}` : "Loading Lighter markets…"}</p>;
  return (
    <table className="terminal-table signal-table lighter-markets">
      <thead><tr><th>MARKET</th><th className="r">LAST</th><th className="r">24H</th><th className="r">VOL</th></tr></thead>
      <tbody>
        {rows.map((market: LighterMarket) => {
          const row = marketRow(market);
          return (
            <tr className={selected === row.key ? "selected" : ""} key={row.key} onClick={() => onPick?.(row.key, market.symbol)} style={{ cursor: "pointer" } as CSSProperties}>
              <td><b>{row.symbol}</b><small>PERP · {market.status.toUpperCase()}</small></td>
              <td className="r">{row.last}</td>
              <td className={`r ${row.changeTone}`}>{row.change}</td>
              <td className="r">{row.vol}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
