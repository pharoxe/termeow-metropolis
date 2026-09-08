import type { ParticipantSnapshot } from "../../shared/participant";
import type { TradeEvent } from "../../shared/terminal";
import type { MarketCandle } from "../../shared/wire";
import type { ChartMarker } from "./chartMarkers";
import { candleIndexFor } from "./fomoMarkers";

export type TradeFilter = { side: "all"|"buy"|"sell"; cohort:"all"|"named"|"followed"|"fomo"; minimum:number; influencerFollowers:number; walletMinimum?:number };
/** The FOMO rank floor defaults to 0 because every floor below the lowest follower count present in the data
 *  selects an identical set: a non-zero default would advertise a gate the data cannot support. The floor that
 *  is actually observed is measured live per load (TradeFilterBreakdown.rankFloor) and shown beside the control. */
export const DEFAULT_TRADE_FILTER:TradeFilter={side:"all",cohort:"all",minimum:500,influencerFollowers:0};
export const walletId=(e:Pick<TradeEvent,"chain"|"wallet">)=>`${e.chain}:${e.wallet??""}`;
/** Why loaded rows are not on screen. Every hidden row is counted exactly once, under the first reason that
 *  applies in this order: side, cohort, wallet gate, rank floor, no USD value, size. shown + the six hidden
 *  counts === loaded. */
export type TradeFilterBreakdown = {
  loaded:number; shown:number;
  hiddenBySide:number; hiddenByCohort:number; hiddenByWallet:number; hiddenByRank:number; hiddenUnderMinimum:number; hiddenUsdUnknown:number;
  /** Named FOMO rows carrying no follower count at all: unrankedLoaded were loaded, shownUnranked reached the screen. */
  unrankedLoaded:number; shownUnranked:number;
  /** Follower counts actually present in the loaded named FOMO rows; null when not one of them carries a count. */
  rankFloor:number|null; rankCeiling:number|null;
  /** Tracked wallets whose valuation could satisfy a threshold right now, out of the wallets tracked at all. */
  walletsValued:number; walletsTracked:number;
};
export type WalletGateState = { usable:boolean; reason:string };
export type HiddenReason = { key:"size"|"usd"|"side"|"cohort"|"wallet"|"rank"; count:number; label:string };
const snapshotKey=(chain:string,wallet:string)=>`${chain}::${wallet}`;
const usableValuation=(s:ParticipantSnapshot,now:number)=>s.status==='fresh'&&s.balanceComplete&&s.checkedAt!=null&&s.nextCheckAt>now&&s.balanceUsd!=null;
/** One pass over the events: the rows that survive, and the single attributed reason for every row that does not. */
export function filterTradesWithBreakdown(events:TradeEvent[],filter:TradeFilter,followed:string[],snapshots:ParticipantSnapshot[]=[],now=Date.now()):{trades:TradeEvent[];breakdown:TradeFilterBreakdown}{
  const baselines=new Map<string,ParticipantSnapshot>();
  for(const s of snapshots){const key=snapshotKey(s.chain,s.wallet);if(!baselines.has(key))baselines.set(key,s);} // first snapshot wins, exactly as the previous per-event find() did
  let walletsValued=0;for(const s of baselines.values())if(usableValuation(s,now))walletsValued++;
  const trades:TradeEvent[]=[];
  let hiddenBySide=0,hiddenByCohort=0,hiddenByWallet=0,hiddenByRank=0,hiddenUnderMinimum=0,hiddenUsdUnknown=0;
  let unrankedLoaded=0,shownUnranked=0,rankFloor:number|null=null,rankCeiling:number|null=null;
  for(const e of events){
    const named = e.kind === "fomo" && Boolean(e.wallet && e.handle);
    const rank = typeof e.followers === "number" && Number.isFinite(e.followers) ? e.followers : null;
    if(named && rank === null) unrankedLoaded++;
    if(named && rank !== null){rankFloor=rankFloor===null||rank<rankFloor?rank:rankFloor;rankCeiling=rankCeiling===null||rank>rankCeiling?rank:rankCeiling;}
    const significant = Number.isFinite(e.usd) && (e.usd ?? -1) >= filter.minimum;
    const influencer = notableFomo(e, filter.influencerFollowers);
    const cohort = filter.cohort === "all" || filter.cohort === "named" && Boolean(e.handle) || filter.cohort === "fomo" && e.kind === "fomo" || filter.cohort === "followed" && followed.includes(walletId(e));
    const side = filter.side === "all" || e.side === filter.side;
    const baseline = e.wallet == null ? undefined : baselines.get(snapshotKey(e.chain, e.wallet));
    const walletMatches=!filter.walletMinimum || Boolean(baseline && baseline.status==='fresh' && baseline.balanceComplete && baseline.checkedAt!=null && baseline.nextCheckAt>now && (baseline.balanceUsd??-1)>=filter.walletMinimum);
    if(walletMatches && (significant || influencer) && cohort && side){trades.push(e);if(named&&rank===null)shownUnranked++;continue;}
    if(!side)hiddenBySide++;
    else if(!cohort)hiddenByCohort++;
    else if(!walletMatches)hiddenByWallet++;
    else if(named&&rank!==null&&rank<filter.influencerFollowers)hiddenByRank++; // a lower rank floor, not a lower size floor, is what reveals these
    else if(!Number.isFinite(e.usd))hiddenUsdUnknown++;
    else hiddenUnderMinimum++;
  }
  return {trades,breakdown:{loaded:events.length,shown:trades.length,hiddenBySide,hiddenByCohort,hiddenByWallet,hiddenByRank,hiddenUnderMinimum,hiddenUsdUnknown,unrankedLoaded,shownUnranked,rankFloor,rankCeiling,walletsValued,walletsTracked:baselines.size}};
}
/** A named FOMO wallet counts as notable at or above the rank floor. A wallet whose follower count was never
 *  recorded stays visible as named-but-unranked: a missing count is not a count of zero, and no threshold can
 *  rank it, so excluding it would hide that trade at every setting including 0. */
export function notableFomo(e:TradeEvent, minimumFollowers:number):boolean {
  if(e.kind !== "fomo" || !e.wallet || !e.handle) return false;
  return typeof e.followers === "number" && Number.isFinite(e.followers) ? e.followers >= minimumFollowers : true;
}
/** Hidden-row counts in display order. A reason is reported whenever it hides something, and also whenever its
 *  own control is switched on, so an active control that hides nothing says so instead of staying silent. */
export function hiddenReasons(filter:TradeFilter,b:TradeFilterBreakdown):HiddenReason[]{
  const all:(HiddenReason&{always:boolean})[]=[
    {key:"size",count:b.hiddenUnderMinimum,label:"under the trade-size floor",always:filter.minimum>0},
    {key:"usd",count:b.hiddenUsdUnknown,label:"no USD value reported by the source",always:false},
    {key:"rank",count:b.hiddenByRank,label:"below the FOMO rank floor",always:filter.influencerFollowers>0},
    {key:"side",count:b.hiddenBySide,label:"excluded by the side selector",always:filter.side!=="all"},
    {key:"cohort",count:b.hiddenByCohort,label:"excluded by the cohort selector",always:filter.cohort!=="all"},
    {key:"wallet",count:b.hiddenByWallet,label:"excluded by the wallet valuation gate",always:Boolean(filter.walletMinimum)},
  ];
  return all.filter(r=>r.count>0||r.always).map(({key,count,label})=>({key,count,label}));
}
/** The valuation thresholds stay off until every tracked wallet carries a usable valuation: under partial
 *  coverage the gate drops rows for missing data rather than for wallet size, and cannot say which is which. */
export function walletGateState(breakdown?:TradeFilterBreakdown):WalletGateState{
  if(!breakdown)return{usable:false,reason:"Wallet valuation coverage is not reported in this view, so the valuation thresholds stay off."};
  const valued=breakdown.walletsValued,tracked=breakdown.walletsTracked;
  if(tracked===0)return{usable:false,reason:"Valuation thresholds are off: no wallet valuations are tracked yet, so a threshold would hide every row."};
  if(valued<tracked)return{usable:false,reason:`Valuation thresholds are off: ${valued} of ${tracked} tracked wallets carry a fresh, complete valuation. Switching one on would hide the other ${tracked-valued} for missing data, not for wallet size.`};
  return{usable:true,reason:`All ${tracked} tracked wallets carry a fresh, complete valuation.`};
}
/** What each `quantitySource` claims, in the reader's words. The bare enum cannot tell an exact re-checkable
 *  division ("derived") from one over a provider's rounded inputs ("provider-estimated"), and "estimated" now
 *  means only "archived before that split was recorded" while reading identically to the old label. */
export const QUANTITY_SOURCE_LABELS:Record<TradeEvent["quantitySource"],{short:string;title:string}>={
  decoded:{short:"decoded",title:"Token amount read off the chain here: a Solana swap delta or a Robinhood Transfer's own data word."},
  derived:{short:"derived",title:"This row's own USD divided by its own price, both decoded here. Exact arithmetic you can re-check, not a guess."},
  "provider-estimated":{short:"provider est.",title:"The same division over a provider's USD and price, so it inherits whatever that provider rounded."},
  estimated:{short:"estimated · legacy",title:"Archived before decoded and provider inputs were labelled apart, so which of the two this division used was not recorded."},
  unknown:{short:"unknown",title:"No basis for a quantity at all. Unknown, never 0."}
};
/** The label for a stored value, including one this build does not know: an unrecognised source is shown as itself. */
export function quantitySourceLabel(source:TradeEvent["quantitySource"]):{short:string;title:string}{
  return QUANTITY_SOURCE_LABELS[source]??{short:source,title:"Unrecognised quantity provenance recorded by an older build."};
}
export function containingCandle(times:number[],time:number,intervalMs:number):number{
  const index=candleIndexFor(times,time);
  return index>=0&&Number.isFinite(time)&&intervalMs>0&&time<times[index]+intervalMs?index:-1;
}
/** Candle containment is mandatory. Empty intervals and later trades never attach to an older candle. */
export function tradeMarkers(events:TradeEvent[],candles:MarketCandle[],intervalMs:number,selected:string|null,followed:string[],visible?:{from:number;to:number}|null):{markers:ChartMarker[];unplaced:number;clusters:number}{
  const times=candles.map(c=>c.time);const buckets=new Map<string,{time:number;side:"buy"|"sell";events:TradeEvent[]}>();let unplaced=0;
  for(const e of events){
    if(visible&&(e.time<visible.from||e.time>visible.to))continue;
    const i=containingCandle(times,e.time,intervalMs);if(i<0){unplaced++;continue;}
    const key=`${i}:${e.side}`;const bucket=buckets.get(key)??{time:times[i],side:e.side,events:[]};bucket.events.push(e);buckets.set(key,bucket);
  }
  const markers=[...buckets.values()].map(b=>{
    const picked=b.events.find(e=>e.id===selected);const named=picked??b.events.find(e=>followed.includes(walletId(e)))??b.events.find(e=>e.kind==="fomo"&&e.handle);
    const usd=b.events.reduce((s,e)=>s+(e.usd??0),0);
    return {time:b.time/1000,position:b.side==="buy"?"belowBar" as const:"aboveBar" as const,shape:b.side==="buy"?"arrowUp" as const:"arrowDown" as const,color:picked?"#69acff":b.side==="buy"?"#42c99a":"#ef7885",text:named?`${named.handle??named.wallet?.slice(0,6)??"Trade"}${b.events.length>1?` +${b.events.length-1}`:""}`:"",size:picked?1.2:usd>=5000?0.8:0.5};
  }).sort((a,b)=>a.time-b.time);
  return {markers,unplaced,clusters:markers.length};
}
export function tradeContext(event:TradeEvent,candles:MarketCandle[],intervalMs:number):string[]{
  const index=containingCandle(candles.map(c=>c.time),event.time,intervalMs);
  if(index<1)return ["Not enough preceding candle history for context."];
  // Completed bars only: using the containing candle's final high/volume would leak later information.
  const prior=candles.slice(Math.max(0,index-20),index);const last=prior.at(-1)!;
  const sum=prior.reduce((s,c)=>s+c.volume,0);const vwap=sum>0?prior.reduce((s,c)=>s+((c.high+c.low+c.close)/3)*c.volume,0)/sum:null;
  const result=[`Previous completed candle closed at $${last.close.toPrecision(5)}.`];
  if(event.price&&vwap)result.push(`Execution was ${event.price>=vwap?"above":"below"} the preceding ${prior.length}-bar volume-weighted typical price.`);
  result.push("These are observed conditions, not the trader’s stated reason.");return result;
}
export function observedActivity(event:TradeEvent,events:TradeEvent[]):string{
  if(!event.wallet)return "Unattributed pool activity";
  const older=events.filter(e=>walletId(e)===walletId(event)&&e.token===event.token&&(e.time<event.time||e.time===event.time&&e.id<event.id));
  if(!older.length)return `First ${event.side} in loaded history`;
  return event.side==="buy"?"Observed purchase":"Observed sale · exit unconfirmed";
}
