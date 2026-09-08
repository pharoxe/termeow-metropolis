import type { ParticipantSnapshot } from "../../shared/participant";
import { useMemo, useState } from "react";
import type { TradeEvent } from "../../shared/terminal";
import type { MarketCandle } from "../../shared/wire";
import { money } from "../lib/format";
import { hiddenReasons, observedActivity, quantitySourceLabel, tradeContext, walletGateState, walletId, type HiddenReason, type TradeFilter, type TradeFilterBreakdown } from "../lib/terminal";

const short=(s:string|null)=>s?`${s.slice(0,6)}…${s.slice(-4)}`:"Unattributed";
const clock=(ms:number)=>new Date(ms).toLocaleTimeString("en-GB",{hour12:false,timeZone:"UTC"});
const count=(n:number)=>n.toLocaleString();
export function TraderToolbar({filter,onFilter,status,connected,matched,loaded,unplaced,following,onClear,paused,onPause,breakdown}:{filter:TradeFilter;onFilter:(v:TradeFilter)=>void;status:string;connected:boolean;matched:number;loaded:number;unplaced:number;following:number;onClear:()=>void;paused:boolean;onPause:()=>void;breakdown?:TradeFilterBreakdown}){
  const gate=walletGateState(breakdown);
  const reasons=breakdown?hiddenReasons(filter,breakdown):[];
  const hidden=breakdown?breakdown.loaded-breakdown.shown:0;
  const reasonText=(r:HiddenReason)=>`${count(r.count)} ${r.label}${r.key==="size"?` of $${count(filter.minimum)}`:r.key==="rank"?` of ${count(filter.influencerFollowers)}`:""}`;
  const rankNote=!breakdown?"range unreported"
    :breakdown.rankFloor==null?"no counts observed"
    :`observed ${count(breakdown.rankFloor)}${breakdown.rankCeiling!=null&&breakdown.rankCeiling!==breakdown.rankFloor?`–${count(breakdown.rankCeiling)}`:""}`;
  return <div className="trader-toolbar">
    <div className="trader-toolbar-heading"><strong>PARTICIPANTS</strong><span className={`terminal-health ${status==="PARTIAL LIVE"?"fresh":""}`}><i/>{status}</span><small>{connected?"Streaming observations":"Retrying connection"}</small></div>
    <div className="trader-filters">
      <label>Show<select aria-label="Trader cohort" value={filter.cohort} onChange={e=>onFilter({...filter,cohort:e.target.value as TradeFilter["cohort"]})}><option value="all">Impact activity</option><option value="named">Named traders</option><option value="followed">Following ({following})</option><option value="fomo">FOMO protocol</option></select></label>
      <label>Side<select aria-label="Trade side" value={filter.side} onChange={e=>onFilter({...filter,side:e.target.value as TradeFilter["side"]})}><option value="all">Buy + sell</option><option value="buy">Buys</option><option value="sell">Sells</option></select></label>
      <label>Trade ≥ USD<input aria-label="Minimum trade USD" type="number" min="0" step="100" list="trade-size-presets" value={filter.minimum} onChange={e=>onFilter({...filter,minimum:Math.max(0,Number(e.target.value)||0)})}/></label>
      <datalist id="trade-size-presets"><option value="500"/><option value="1000"/><option value="5000"/><option value="10000"/></datalist>
      <label>OR named FOMO rank ≥<input aria-label="Minimum FOMO follower rank" type="number" min="0" step="1000" value={filter.influencerFollowers} onChange={e=>onFilter({...filter,influencerFollowers:Math.max(0,Number(e.target.value)||0)})}/><span>{rankNote}</span></label>
      <label>AND wallet ≥<select aria-label="Minimum current wallet valuation" value={filter.walletMinimum??0} onChange={e=>onFilter({...filter,walletMinimum:Number(e.target.value)})}><option value="0">Any / unknown</option><option value="50000" disabled={!gate.usable}>$50K{gate.usable?"":" · off"}</option><option value="100000" disabled={!gate.usable}>$100K{gate.usable?"":" · off"}</option></select><span>{gate.usable?"coverage complete":"off · see below"}</span></label>
      <button onClick={onPause} aria-pressed={paused}>{paused?"RESUME LIVE":"PAUSE / REPLAY"}</button>
      <button onClick={onClear}>RESET IMPACT</button>
      <span className="trader-count">{breakdown?`${count(breakdown.shown)} shown · ${count(breakdown.loaded)} loaded here`:`${count(loaded)} shown`} · {count(matched)} captured in this window on the server{unplaced>0?` · ${count(unplaced)} outside candle coverage`:""}</span>
    </div>
    <small className="terminal-notice">
      {!breakdown?"Hidden rows are not itemised in this view, so the reasons below are the only ones stated. ":
        hidden>0?`Hidden ${count(hidden)} of ${count(breakdown.loaded)} loaded rows: ${reasons.map(reasonText).join("; ")}. Each hidden row is counted once, under the first reason that applies in this order: side, cohort, wallet gate, rank floor, no USD value, size. `
          :`No loaded row is hidden by the current filter${reasons.length?` (${reasons.map(r=>r.label).join("; ")} hide nothing right now)`:""}. `}
      {breakdown?`${count(breakdown.unrankedLoaded)} loaded named FOMO rows carry no follower count at all (${count(breakdown.shownUnranked)} on screen): they stay visible as unranked because a missing count is not a count of zero, and no rank floor can rank them. `:""}
      {gate.reason}{" "}
      Trade size OR named FOMO follower threshold · side and cohort apply to both. Small anonymous trades are hidden. Wallet thresholds require a fresh, complete current valuation; unknown and stale snapshots do not qualify. Current balances are not historical balances.
    </small>
  </div>;
}
export function TradeTape({events,selected,onSelect,loading,hasMore,onMore,paused,replayTime,onReplay,error}:{events:TradeEvent[];selected:string|null;onSelect:(e:TradeEvent)=>void;loading:boolean;hasMore:boolean;onMore:()=>void;paused:boolean;replayTime:number|null;onReplay:(time:number)=>void;error:string}){
  const [page,setPage]=useState(0);const size=40;const bounded=Math.min(page,Math.max(0,Math.ceil(events.length/size)-1));const rows=events.slice(bounded*size,(bounded+1)*size);
  return <section className="participant-tape" aria-label="Linked participant trade tape">
    <div className="participant-tape-head"><strong>TIME &amp; SALES</strong><span>UTC · Captured activity · click a row to inspect</span><b>{loading?"UPDATING":""}</b></div>
    {paused&&<label className="replay-control">REPLAY TO <input aria-label="Replay timestamp" type="datetime-local" value={replayTime?new Date(replayTime).toISOString().slice(0,19):""} onChange={e=>{const t=Date.parse(e.target.value+"Z");if(Number.isFinite(t))onReplay(t);}} step="1"/><span>UTC · snapshot frozen · no execution</span></label>}
    {error&&<p className="terminal-notice" role="status">{error}</p>}
    <div className="participant-table-wrap"><table><thead><tr><th>Time</th><th>Participant</th><th>Side</th><th>Notional</th><th>Price</th><th>Venue</th></tr></thead><tbody>{rows.map(e=><tr key={e.id} className={e.id===selected?"selected":""}><td><button aria-label={`Inspect ${e.side} at ${clock(e.time)}`} onClick={()=>onSelect(e)}>{clock(e.time)}</button></td><td><button onClick={()=>onSelect(e)} title={e.wallet??"Provider did not identify the trader"}>{e.handle?`@${e.handle}`:short(e.wallet)}</button>{e.kind==="fomo"&&<small>{e.followers!=null?`${e.followers.toLocaleString()} followers`:"Followers unknown"}</small>}</td><td className={e.side==="buy"?"up":"dn"}>{e.side.toUpperCase()}</td><td>{money(e.usd,true)}</td><td>{money(e.price)}</td><td title={`${e.source} · ${e.granularity}`}>{e.dex}</td></tr>)}</tbody></table></div>
    {!events.length&&<p className="terminal-empty">No captured trades match this chart range and filter. Move to the latest bars, clear filters, or wait for the feed.</p>}
    <div className="tape-pagination"><button disabled={bounded===0} onClick={()=>setPage(bounded-1)}>← NEWER</button><span>{events.length?bounded*size+1:0}–{Math.min((bounded+1)*size,events.length)} of {events.length}</span><button disabled={(bounded+1)*size>=events.length} onClick={()=>setPage(bounded+1)}>OLDER →</button>{hasMore&&<button disabled={loading} onClick={onMore}>LOAD HISTORY</button>}</div>
  </section>;
}
export function TraderInspector({baseline,event,events,candles,intervalMs,followed,onFollow,onSelect,onClose}:{baseline?:ParticipantSnapshot;event:TradeEvent|null;events:TradeEvent[];candles:MarketCandle[];intervalMs:number;followed:string[];onFollow:(key:string)=>void;onSelect:(e:TradeEvent)=>void;onClose:()=>void}){
  const history=useMemo(()=>event?.wallet?events.filter(e=>walletId(e)===walletId(event)&&e.token===event.token).sort((a,b)=>a.time-b.time):[],[event,events]);
  if(!event)return <section className="trader-inspector empty-inspector"><div className="inspector-kicker">TRADER INTELLIGENCE</div><h2>Every trade has context.</h2><p>Select a candle or a row in Time &amp; Sales to inspect the participant, transaction and preceding market conditions.</p><div className="inspector-explainer"><b>01 / WHO</b><p>Wallet attribution and sourced public handles.</p><b>02 / WHAT</b><p>Observed buys and sells, with transaction evidence.</p><b>03 / CONTEXT</b><p>Market conditions at the time. Motives remain unknown unless stated by the trader.</p></div><small>Historical coverage starts when this server captures activity. Unknown is never treated as zero.</small></section>;
  const explorer=event.chain==="solana"?`https://solscan.io/tx/${encodeURIComponent(event.tx)}`:`https://robinhoodchain.blockscout.com/tx/${encodeURIComponent(event.tx)}`;
  const facts=tradeContext(event,candles,intervalMs);
  return <section className="trader-inspector" aria-label="Selected trader details"><div className="inspector-kicker">TRADE INSPECTOR<button aria-label="Close trader details" onClick={onClose}>×</button></div><h2>{event.handle?`@${event.handle}`:short(event.wallet)}</h2><p className="wallet-address">{event.wallet??"No wallet attribution from this source"}</p><div className="inspector-actions">{event.wallet&&<button onClick={()=>onFollow(walletId(event))}>{followed.includes(walletId(event))?"★ FOLLOWING":"☆ FOLLOW WALLET"}</button>}<a href={explorer} target="_blank" rel="noreferrer">TRANSACTION ↗</a></div>
    <div className={`selected-trade ${event.side}`}><strong>{event.side.toUpperCase()} {money(event.usd,true)}</strong><span>{new Date(event.time).toLocaleString("en-GB",{timeZone:"UTC"})} UTC</span></div>
    <div className="baseline-status" role="status" key={baseline?.checkedAt??"pending"}><b>{baseline?.status==="fresh"&&baseline.nextCheckAt<=Date.now()?"STALE · REFRESH DUE":baseline?.status.toUpperCase()??"BASELINE QUEUED"}</b><span>Current wallet valuation: {money(baseline?.balanceUsd,true)}{baseline&&!baseline.balanceComplete?" · partial / unavailable":""}</span><small>{baseline?.checkedAt?`Observed ${new Date(baseline.checkedAt).toLocaleTimeString()} · next check ${new Date(baseline.nextCheckAt).toLocaleTimeString()}`:"Waiting for a baseline snapshot"}</small>{baseline?.error&&<small>{baseline.error}</small>}<small>Reference market valuation · not historical holdings or proof of social ownership</small></div>
    <dl className="trade-facts"><dt>Price / token</dt><dd>{money(event.price)}</dd><dt>Quantity</dt><dd>{event.quantity?.toLocaleString("en-US",{maximumSignificantDigits:8})??"Unknown"} <small title={quantitySourceLabel(event.quantitySource).title}>{quantitySourceLabel(event.quantitySource).short}</small></dd><dt>Venue</dt><dd>{event.dex}</dd><dt>Network</dt><dd>{event.chain}</dd><dt>Observation</dt><dd>{event.granularity}</dd><dt>Price source</dt><dd>{event.source}</dd><dt>Identity evidence</dt><dd>{event.identitySource}</dd><dt>Social attribution</dt><dd>{event.handle?"Provider wallet-to-handle mapping · ownership unverified":"No sourced social mapping"}</dd><dt>Protocol verification</dt><dd>{event.chain==="robinhood"&&event.kind==="fomo"?"FOMO delegation observed · not social identity verification":event.kind==="seeded"?"Seeded · verification pending":"No supported verification evidence"}</dd><dt>Confirmation</dt><dd>Observed · finality unverified</dd><dt>Received</dt><dd>{clock(event.receivedAt)} UTC</dd></dl>
    <div className="inspector-section"><h3>OBSERVED ACTIVITY</h3><p>{observedActivity(event,history)}</p><p className="terminal-notice">Opening balance, complete cost basis and remaining inventory are unknown. A sale does not establish a full exit. Realized P&amp;L is unavailable.</p></div>
    <div className="inspector-section"><h3>CONTEXT AT THE TIME</h3>{facts.map(f=><p key={f}>{f}</p>)}<div className="motive-label">TRADER’S STATED REASON <b>Not available</b></div></div>
    <div className="inspector-section"><h3>PARTICIPANT TIMELINE <small>{history.length} loaded observations</small></h3>{history.slice(-30).reverse().map(e=><button className={`timeline-row ${e.id===event.id?"active":""}`} key={e.id} onClick={()=>onSelect(e)}><span>{clock(e.time)}</span><b className={e.side==="buy"?"up":"dn"}>{e.side.toUpperCase()}</b><span>{money(e.usd,true)}</span></button>)}</div>
  </section>;
}
