import type {ParticipantSnapshot} from "../../shared/participant";
import { describe,expect,it } from "vitest";
import type { TradeEvent } from "../../shared/terminal";
import { containingCandle,filterTradesWithBreakdown,hiddenReasons,notableSmart,tradeMarkers,tradeContext,observedActivity,walletGateState,DEFAULT_TRADE_FILTER } from "./terminal";
/** The rows that survive the filter: the desk reads them off filterTradesWithBreakdown, and so does every assertion here. */
const shown=(...args:Parameters<typeof filterTradesWithBreakdown>)=>filterTradesWithBreakdown(...args).trades;
const e=(extra:Partial<TradeEvent>={}):TradeEvent=>({id:"1",revision:1,chain:"monad",token:"Token",pair:"pool",dex:"dex",tx:"Tx",time:1000,receivedAt:2000,side:"buy",usd:100,price:2,wallet:"Wallet",handle:null,kind:"other",identitySource:"receipt",source:"own",granularity:"transaction-pool",quantity:50,quantitySource:"decoded",confirmation:"observed",...extra});
describe("linked trader context",()=>{
  it("does not pin a gap or future trade to an older candle",()=>{expect(containingCandle([0,60000],30000,15000)).toBe(-1);expect(containingCandle([0,60000],75000,15000)).toBe(-1);expect(containingCandle([0,60000],74999,15000)).toBe(1);});
  it("combines side, notional and exact chain-specific wallet filters",()=>{expect(shown([e(),e({id:"2",wallet:"wallet"})],{...DEFAULT_TRADE_FILTER,cohort:"followed",minimum:0},["monad:Wallet"])).toHaveLength(1);expect(shown([e({usd:null})],{...DEFAULT_TRADE_FILTER,minimum:1},[])).toHaveLength(0);});
  it("defaults to significant trades or sourced notable SMART wallets",()=>{
    const input=[e({id:"small",usd:499}),e({id:"large",usd:500}),e({id:"famous",usd:5,kind:"smart",handle:"known",followers:10000}),e({id:"unknown",usd:5,kind:"smart",handle:"named"}),e({id:"anonymous",usd:5,kind:"smart",followers:100000}),e({id:"bad",usd:NaN})];
    expect(shown(input,DEFAULT_TRADE_FILTER,[]).map(x=>x.id)).toEqual(["large","famous","unknown"]);
    // "unknown" is a named SMART wallet whose follower count was never recorded: it survives a floor no recorded count reaches.
    expect(shown(input,{...DEFAULT_TRADE_FILTER,minimum:1000,influencerFollowers:10001},[]).map(x=>x.id)).toEqual(["unknown"]);
    expect(shown(input,{...DEFAULT_TRADE_FILTER,side:"sell"},[])).toEqual([]);
  });
  it("requires fresh complete current valuations for wallet thresholds",()=>{
    const snapshot:ParticipantSnapshot={chain:'monad',wallet:'Wallet',balanceUsd:100000,balanceComplete:true,checkedAt:1000,attemptedAt:1000,nextCheckAt:2000,status:'fresh',handle:null,followers:null,protocol:'unknown',socialOwnership:'unverified',error:null};
    const events=[e({usd:1000})],filter={...DEFAULT_TRADE_FILTER,walletMinimum:50000};
    expect(shown(events,filter,[],[snapshot],1500)).toHaveLength(1);
    expect(shown(events,filter,[],[snapshot],2000)).toHaveLength(0);
    expect(shown(events,filter,[],[{...snapshot,balanceComplete:false}],1500)).toHaveLength(0);
    expect(shown(events,filter,[],[{...snapshot,status:'error'}],1500)).toHaveLength(0);
    expect(shown(events,filter,[],[],1500)).toHaveLength(0);
  });
  it("clusters same-candle trades and labels only selected or followed wallets",()=>{const candles=[{time:0,open:1,high:2,low:1,close:2,volume:100}];const result=tradeMarkers([e(),e({id:"2"}),e({id:"3",time:20000})],candles,15000,null,[]);expect(result.markers).toHaveLength(1);expect(result.markers[0].text).toBe("");expect(result.unplaced).toBe(1);});
  it("never uses the containing candle's future high or volume to explain a trade",()=>{const candles=[{time:0,open:1,high:1,low:1,close:1,volume:1},{time:15000,open:1,high:1000,low:1,close:1000,volume:100000}];const context=tradeContext(e({time:16000}),candles,15000);expect(context.join(" ")).not.toContain("1000");expect(context.join(" ")).toContain("not the trader");});
  it("keeps a named SMART fill with no follower count visible at every rank floor",()=>{
    // The archive's lowest recorded count is far above any plausible default, so a rank floor cannot reveal these
    // rows by being lowered: a missing count is not a count of zero and must not be filtered as one.
    const unranked=e({id:"unranked",usd:5,kind:"smart",handle:"named"});
    expect(DEFAULT_TRADE_FILTER.influencerFollowers).toBe(0);
    expect(shown([unranked],DEFAULT_TRADE_FILTER,[]).map(x=>x.id)).toEqual(["unranked"]);
    expect(shown([unranked],{...DEFAULT_TRADE_FILTER,influencerFollowers:500000},[]).map(x=>x.id)).toEqual(["unranked"]);
    const {breakdown}=filterTradesWithBreakdown([unranked],{...DEFAULT_TRADE_FILTER,influencerFollowers:500000},[]);
    expect([breakdown.unrankedLoaded,breakdown.shownUnranked,breakdown.rankFloor]).toEqual([1,1,null]);
    expect(notableSmart(e({kind:"smart",handle:"named",followers:null}),500000)).toBe(true);
    expect(notableSmart(e({kind:"smart",handle:null,followers:null}),0)).toBe(false); // no handle is not "named but unranked"
  });
  it("attributes every hidden row to exactly one reason and counts them in the same pass",()=>{
    const mixed=[e({id:"big",usd:1000}),e({id:"small",usd:100}),e({id:"nousd",usd:null}),e({id:"sell",usd:1000,side:"sell"}),e({id:"lowrank",usd:5,kind:"smart",handle:"k",followers:900}),e({id:"unranked",usd:5,kind:"smart",handle:"k"})];
    const {trades,breakdown}=filterTradesWithBreakdown(mixed,{...DEFAULT_TRADE_FILTER,side:"buy",minimum:500,influencerFollowers:1000},[]);
    expect(trades.map(t=>t.id)).toEqual(["big","unranked"]);
    expect(breakdown.hiddenUnderMinimum).toBe(1);
    expect(breakdown.hiddenUsdUnknown).toBe(1); // a null notional is not a small notional
    expect(breakdown.hiddenBySide).toBe(1);
    expect(breakdown.hiddenByRank).toBe(1);
    expect(breakdown.hiddenByCohort).toBe(0);
    expect(breakdown.hiddenByWallet).toBe(0);
    expect(breakdown.hiddenBySide+breakdown.hiddenByCohort+breakdown.hiddenByWallet+breakdown.hiddenByRank+breakdown.hiddenUnderMinimum+breakdown.hiddenUsdUnknown+breakdown.shown).toBe(breakdown.loaded);
    expect([breakdown.rankFloor,breakdown.rankCeiling]).toEqual([900,900]);
    const cohort=filterTradesWithBreakdown(mixed,{...DEFAULT_TRADE_FILTER,cohort:"followed"},[]).breakdown;
    expect([cohort.hiddenByCohort,cohort.shown]).toEqual([6,0]);
  });
  it("reports a switched-on control that hides nothing instead of staying silent",()=>{
    const {breakdown}=filterTradesWithBreakdown([e({usd:1000})],{...DEFAULT_TRADE_FILTER,side:"buy"},[]);
    const reasons=hiddenReasons({...DEFAULT_TRADE_FILTER,side:"buy"},breakdown);
    expect(reasons.find(r=>r.key==="side")).toEqual({key:"side",count:0,label:"excluded by the side selector"});
    expect(reasons.find(r=>r.key==="usd")).toBeUndefined(); // no control, nothing hidden, nothing claimed
  });
  it("keeps the wallet valuation thresholds off while coverage is incomplete",()=>{
    const snapshot:ParticipantSnapshot={chain:'monad',wallet:'Wallet',balanceUsd:100000,balanceComplete:true,checkedAt:1000,attemptedAt:1000,nextCheckAt:2000,status:'fresh',handle:null,followers:null,protocol:'unknown',socialOwnership:'unverified',error:null};
    const blind=filterTradesWithBreakdown([e({usd:1000})],{...DEFAULT_TRADE_FILTER,walletMinimum:50000},[],[],1500).breakdown;
    expect([blind.walletsTracked,blind.walletsValued,blind.hiddenByWallet]).toEqual([0,0,1]);
    expect(walletGateState(blind)).toEqual({usable:false,reason:"Valuation thresholds are off: no wallet valuations are tracked yet, so a threshold would hide every row."});
    const partial=filterTradesWithBreakdown([e({usd:1000})],DEFAULT_TRADE_FILTER,[],[snapshot,{...snapshot,wallet:'Other',status:'unavailable',balanceUsd:null,balanceComplete:false}],1500).breakdown;
    expect([partial.walletsTracked,partial.walletsValued]).toEqual([2,1]);
    expect(walletGateState(partial).usable).toBe(false);
    expect(walletGateState(partial).reason).toContain("1 of 2 tracked wallets");
    expect(walletGateState(filterTradesWithBreakdown([],DEFAULT_TRADE_FILTER,[],[snapshot],1500).breakdown)).toEqual({usable:true,reason:"All 1 tracked wallets carry a fresh, complete valuation."});
    expect(walletGateState(undefined).usable).toBe(false); // an unreported coverage figure is not a complete one
  });
  it("resolves a duplicated wallet snapshot to the first one, as the per-event lookup did",()=>{
    const snapshot:ParticipantSnapshot={chain:'monad',wallet:'Wallet',balanceUsd:100000,balanceComplete:true,checkedAt:1000,attemptedAt:1000,nextCheckAt:2000,status:'fresh',handle:null,followers:null,protocol:'unknown',socialOwnership:'unverified',error:null};
    const snapshots=[snapshot,{...snapshot,balanceUsd:1}];
    const filter={...DEFAULT_TRADE_FILTER,walletMinimum:50000},events=[e({usd:1000})];
    expect(shown(events,filter,[],snapshots,1500)).toHaveLength(1);
  });
  it("does not classify partial sales as exits",()=>{expect(observedActivity(e({side:"sell",time:2000}),[e()])).toContain("exit unconfirmed");});
});
