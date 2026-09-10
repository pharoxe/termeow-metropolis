import { useState, type JSX } from "react";
import type { IdentityBoardResponse, IdentityCoverageResponse, RankedTrader, TraderRanking } from "../../shared/identity";
import type { Chain } from "../../shared/wire";
import { api } from "../api/client";
import { printAgeLabel } from "../lib/flowPanel";
import {
  BOARD_CHOICES, IDENTITY_POLL_MS, budgetLabel, capturedLabel, holdLabel, namedLabel, pnlSplit, populationLabel, shortWallet, walletAgeLabel, winRateLabel,
  type BoardChoice
} from "../lib/identity";
import { useResource } from "../lib/resource";

/** What this row carried, not what the board publishes: the same row on a filled board would say something else. */
const NO_STATS = "no per-row stats in this snapshot";
const NO_UNREALIZED = "unrealized not reported";
const NET_FLOW_NOTE = "cash flow · not PnL";
const POPULATION_TITLE = "a board is the top of the population it was swept from, never the top of everyone trading";
const CAPTURED_TITLE = "two clocks: capturedAt is the instant the board itself was sampled upstream, and the read time beside it is when this server last fetched it";

/** Only the fields this board actually filled: a null stat is unobserved, and a 0 printed in its place would be a claim. */
function statLine(row: TraderRanking, now: number): string {
  return [
    row.winRate == null ? null : `WIN ${winRateLabel(row.winRate)}`,
    row.trades == null ? null : `${row.trades} TX`,
    row.uniqueTokens == null ? null : `${row.uniqueTokens} TOK`,
    row.avgHoldSeconds == null ? null : `HELD ${holdLabel(row.avgHoldSeconds)}`,
    row.tokensCreated == null ? null : `${row.tokensCreated} CREATED`,
    row.walletFirstSeenAt == null ? null : `AGE ${walletAgeLabel(row.walletFirstSeenAt, now)}`
  ].filter((part): part is string => part != null).join(" · ");
}

/** Five states a reader has to be able to tell apart; an unqualified empty table would read as "nobody traded". */
function emptyCopy(choice: BoardChoice, board: { loaded: boolean; failure: string }, coverage: IdentityCoverageResponse | null): string {
  if (board.failure) return `Board request failed · ${board.failure}`;
  if (!board.loaded) return "Reading the stored snapshot…";
  if (coverage && !coverage.account.connected) return "No FomoScan key is configured here, so no board has ever been read.";
  // An unknown window is answered 200 with no rows, so an empty table alone cannot separate "not read yet" from "this
  // chip no longer names a board the collector fetches". Coverage lists every board the server holds, so it can.
  if (coverage && !coverage.boards.some((item) => item.board === choice.board && item.window === choice.window))
    return `The server lists no ${choice.label} snapshot: either it has never been read, or this desk's board list has drifted from the collector's.`;
  return `No stored snapshot of ${choice.label} yet. Boards refresh on a metered timer — opening this tab does not fetch one.`;
}

function SmartMoneyRow({ row, now }: { row: RankedTrader; now: number }) {
  const split = pnlSplit(row);
  const stats = statLine(row, now);
  // The registry names these wallets for nothing, so prefer the name and keep the address in the title: an unnamed row
  // is a wallet no board we have read has named, not an anonymous trader, so it still ranks under its address.
  const name = row.identity?.handle ?? null;
  const title = [row.wallet, row.identity?.displayName, stats].filter(Boolean).join(" · ");
  return (
    <tr className="static">
      {/* The rail measured 280px at a 1600px viewport, so both small lines ellipsize; the title carries them in full. */}
      <td title={title}><b>{row.rank} · {name ?? shortWallet(row.wallet)}</b><small>{stats || NO_STATS}</small></td>
      <td className={`r ${split.tone}`} title={split.title}>
        <b className={split.tone}>{split.realized}</b>
        <small>{row.board === "fomoscan-traders" && row.netUsd != null ? NET_FLOW_NOTE : split.unrealized ?? NO_UNREALIZED}{split.paperDominant ? <span className="chip warn" title={split.title}>PAPER</span> : null}</small>
      </td>
    </tr>
  );
}

/**
 * SMART MONEY: the stored FomoScan boards from /api/identity, ranked wallet by ranked wallet.
 *
 * useResource rather than DiscoverTab's useEffect + setInterval, because this body reads two resources with different
 * scopes: coverage is board-independent, so a keyed store restarts only the board poll on a chip change while the
 * coverage timer runs on. It also keeps the last snapshot beside the error, which is what lets a failed refresh say
 * "failed" instead of blanking rows that were genuinely read.
 *
 * Rows are addressed by wallet because the board response carries no name: /api/identity/board returns TraderRanking
 * and nothing else. The registry does hold names for these very rows — the top 24h wallet reads back as Dedrater
 * (@0xdedrater) — and that lookup is a local DB read costing nothing, but it is reachable only one address at a time
 * behind /api/identity/wallet. Naming them here wants the board response to carry the handle, not 100 row fetches.
 * The 50,000 CU price is on resolving an address FomoScan has never named, which that route deliberately never does.
 */
export function SmartMoneyTab({ chain }: { chain: Chain }): JSX.Element {
  const [choice, setChoice] = useState<BoardChoice>(BOARD_CHOICES[0]);
  const coverageQuery = useResource<IdentityCoverageResponse>("identity:coverage", () => api.identityCoverage(), IDENTITY_POLL_MS);
  // No limit: the stored snapshot is 100 rows and trimming it here would hide rows the server actually holds.
  const boardQuery = useResource<IdentityBoardResponse>(`identity:board:${choice.board}:${choice.window}:${chain}`, () => api.identityBoard(choice.board, choice.window, undefined, chain), IDENTITY_POLL_MS);

  const now = Date.now();
  const coverage = coverageQuery.data;
  const shown = boardQuery.data?.board === choice.board && boardQuery.data.window === choice.window ? boardQuery.data : null;
  const entries = shown?.entries ?? [];
  // Falls back to the coverage snapshot so a failed board request still reports when the board was last read.
  const snapshot = coverage?.boards.find((item) => item.board === choice.board && item.window === choice.window) ?? null;
  const captured = capturedLabel(entries[0]?.capturedAt ?? snapshot?.capturedAt ?? null, now);
  // The board's capture instant and this server's read of it are days apart in the live data — the 24h sweep was
  // captured 2026-09-03 and read 2026-09-08 — so the chip carries both rather than letting one stand for the other.
  const read = snapshot ? `read ${printAgeLabel(snapshot.observedAt, now)} ago` : null;
  const budget = coverage ? budgetLabel(coverage) : null;
  return (
    <>
      <div className="launch-bar">
        {BOARD_CHOICES.map((item) => (
          <button key={`${item.board}:${item.window}`} type="button" className={item.board === choice.board && item.window === choice.window ? "on" : ""} onClick={() => setChoice(item)}>{item.label}</button>
        ))}
        {/* `pm` is what pushes a status to the right of a `.launch-bar`, as in LAUNCHES; `chip warn` colours a stale capture. */}
        <span className={captured.stale ? "pm chip warn" : "pm chip"} title={CAPTURED_TITLE}>{captured.text}{read ? ` · ${read}` : null}</span>
      </div>
      <p className="pm smart-money-coverage" title={POPULATION_TITLE}>{coverage ? `${populationLabel(coverage, choice.board, choice.window)} · ${namedLabel(coverage)}` : "Coverage not read yet"}</p>
      {budget ? <p className="terminal-notice">{budget}</p> : null}
      {/* /v2/me costs 0 CU and failing it only costs freshness — so the balance survives as a number and would read as
          a current one. Say it is the last one read rather than let a throttle line quote a stale remaining balance. */}
      {coverage?.account.error ? <p className="empty-copy">CU meter unread · {coverage.account.error} · the balance is the last one /v2/me returned, not a current one</p> : null}
      {coverageQuery.error ? <p className="empty-copy">Coverage request failed · {coverageQuery.error}</p> : null}
      {coverage?.lastError ? <p className="empty-copy">Board collector · {coverage.lastError}</p> : null}
      {entries.length ? (
        <table className="terminal-table smart-money-table">
          <thead><tr><th>RANK · WALLET</th><th className="r">{choice.board === "fomoscan-traders" ? "NET FLOW" : "REALIZED · UNREAL"}</th></tr></thead>
          <tbody>{entries.map((row) => <SmartMoneyRow key={`${row.rank}:${row.wallet}`} row={row} now={now} />)}</tbody>
        </table>
      ) : <p className="empty-copy">{emptyCopy(choice, { loaded: boardQuery.updatedAt > 0, failure: boardQuery.error }, coverage ?? null)}</p>}
      {boardQuery.error && entries.length ? <p className="empty-copy">Refresh failed · {boardQuery.error} · the rows above are the last snapshot read</p> : null}
    </>
  );
}
