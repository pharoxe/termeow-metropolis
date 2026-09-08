import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FlowPrint, PairRow } from "../../shared/wire.js";
import { TradeArchive } from "./archive.js";
const archives:TradeArchive[]=[];afterEach(()=>{for(const a of archives.splice(0))a.close();});
const pair={pairAddress:"pool",dex:"test"} as PairRow;
const print=(extra:Partial<FlowPrint>={}):FlowPrint=>({chain:"solana",pair:"pool",tx:"CaseSensitiveTx",time:1000,side:"buy",usd:10,price:2,source:"geckoterminal",...extra});
function archive(){const a=new TradeArchive();archives.push(a);a.bind("solana","Token",[pair]);return a;}
describe("durable event archive",()=>{
  it("deduplicates provider deliveries and upgrades identity without changing event identity",()=>{
    const a=archive();a.ingest([print(),print()]);const revision=a.revision();a.ingest([print()]);expect(a.revision()).toBe(revision);
    a.ingest([print({source:"own",trader:{address:"Wallet",kind:"other",handle:null,followers:null}})]);
    const rows=a.history("solana","Token",0,2000);expect(rows.events).toHaveLength(1);expect(rows.events[0].wallet).toBe("Wallet");expect(rows.revision).toBeGreaterThan(revision);
  });
  it("preserves sourced follower counts when later deliveries omit them",()=>{
    const a=archive();a.ingest([print({trader:{address:"Wallet",kind:"fomo",handle:"known",followers:25000}})]);
    a.ingest([print()]);expect(a.history("solana","Token",0,2000).events[0]).toMatchObject({handle:"known",followers:25000});
  });
  it.each(["solana","robinhood"] as const)("aggregates every captured pool on %s without wallet-net double counts",chain=>{
    const a=archive();a.bind(chain,"Token",[pair,{...pair,pairAddress:"pool2",tier:"B"}]);
    a.ingest([print({chain,eventId:"one",usd:600}),print({chain,usd:999}),print({chain,pair:"pool2",tx:"two",side:"sell",usd:100}),print({chain,pair:"pool2",tx:"unpriced",usd:null})]);
    a.ingest([print({chain,pair:"fomo:Token",trader:{address:"Wallet",handle:null,followers:null,kind:"fomo"},usd:600})],"Token");
    const out=a.aggregate(chain,"Token",0,2000,5000);
    expect(out).toMatchObject({buyUsd:600,sellUsd:100,delta:500,trades:3,unpriced:1,capturedPools:2,knownPools:2});
    expect(out.bars[0].cvd).toBe(500);
    expect(a.aggregate(chain,"Token",1001,2000,5000).trades).toBe(0);
  });
  it("reports the aggregate population's own coverage start, over all time and never the wallet-net rows'",()=>{
    const a=archive();
    a.ingest([print({pair:"fomo:Token",time:200,trader:{address:"Wallet",handle:null,followers:null,kind:"fomo"},usd:5})],"Token");
    a.ingest([print({tx:"pool-first",time:900,usd:10}),print({tx:"pool-late",time:1500,usd:20})]);
    // over all time, so a window opening before capture began can dim the uncovered part instead of drawing it flat
    expect(a.aggregate("solana","Token",1200,2000,5000).firstPrintAt).toBe(900);
    // the wallet-net FOMO row at 200 is not in this population and must not pull its coverage start earlier
    expect(a.aggregate("solana","Token",0,2000,5000)).toMatchObject({firstPrintAt:900,trades:2});
    // nothing captured is null, not 0: a token with no rows has no coverage start to claim
    expect(a.aggregate("solana","Untracked",0,2000,5000).firstPrintAt).toBeNull();
  });
  it("keeps two executions in one transaction and suppresses its coarse provider aggregate",()=>{
    const a=archive();a.ingest([print(),print({source:"own",eventId:"log:1",usd:4}),print({source:"own",eventId:"log:2",usd:6})]);
    const h=a.history("solana","Token",0,2000);expect(h.events).toHaveLength(2);expect(h.matched).toBe(2);expect(h.events.reduce((s,e)=>s+(e.usd??0),0)).toBe(10);
  });
  it("keeps Solana case distinct and lowercases EVM scope",()=>{
    const a=archive();a.ingest([print(),print({tx:"casesensitivetx"})]);expect(a.history("solana","Token",0,2000).events).toHaveLength(2);
    a.bind("robinhood","0xAB",[pair]);a.ingest([print({chain:"robinhood",tx:"0xFF"}),print({chain:"robinhood",tx:"0xff"})]);expect(a.history("robinhood","0xab",0,2000).events).toHaveLength(1);
  });
  it("pages equal timestamps without loss and rejects malformed cursors",()=>{
    const a=archive();a.ingest([1,2,3].map(i=>print({tx:`tx${i}`})));const one=a.history("solana","Token",0,2000,2);const two=a.history("solana","Token",0,2000,2,one.nextCursor!);
    expect(new Set([...one.events,...two.events].map(e=>e.id)).size).toBe(3);expect(two.nextCursor).toBeNull();expect(()=>a.history("solana","Token",0,2000,2,"bad")).toThrow();
  });
  it("separates a decoded quantity from one it divided out of usd and price, and names whose numbers it divided",()=>{
    const a=archive();
    a.ingest([print({eventId:"log:decoded",source:"own",quantity:5,usd:10,price:2})]);
    a.ingest([print({tx:"unpriced",source:"own",quantity:5,usd:null,price:null})]);
    a.ingest([print({tx:"provider",usd:10,price:2})]);
    a.ingest([print({tx:"ownrow",source:"own",usd:10,price:2})]);
    const by=new Map(a.history("solana","Token",0,2000).events.map(e=>[e.tx,e] as const));
    // A size read off the chain stands on its own: it survives with no usd or price to divide.
    expect(by.get("unpriced")).toMatchObject({quantity:5,usd:null,quantitySource:"decoded"});
    expect(by.get("CaseSensitiveTx")).toMatchObject({quantity:5,quantitySource:"decoded"});
    // The same division, told apart by whose usd and price it divided.
    expect(by.get("ownrow")).toMatchObject({quantity:5,quantitySource:"derived"});
    expect(by.get("provider")).toMatchObject({quantity:5,quantitySource:"provider-estimated"});
  });
  it("does not upgrade a provider's carried-over usd and price to an own-decoded claim",()=>{
    const a=archive();
    a.ingest([print({tx:"carried",usd:10,price:2})]);
    // Same event, now delivered by an own-source producer that carried no numbers of its own: the division is still
    // over the provider's usd and price, so the row's own `source` must not promote it to "derived".
    a.ingest([print({tx:"carried",source:"own",usd:null,price:null})]);
    expect(a.history("solana","Token",0,2000).events[0]).toMatchObject({source:"own",usd:10,price:2,quantity:5,quantitySource:"provider-estimated"});
  });
  it("does not demote a decoded quantity when a later delivery of the same event omits it",()=>{
    const a=archive();a.ingest([print({eventId:"log:decoded",source:"own",quantity:5,usd:10,price:2})]);
    a.ingest([print({eventId:"log:decoded",source:"own",usd:20,price:4})]);
    expect(a.history("solana","Token",0,2000).events[0]).toMatchObject({quantity:5,usd:20,quantitySource:"decoded"});
  });
  it("retains late events and corrections after restart",()=>{
    const dir=mkdtempSync(path.join(tmpdir(),"termeow-archive-"));const file=path.join(dir,"trades.db");
    const a=new TradeArchive(file);a.bind("solana","Token",[pair]);a.ingest([print({time:2000}),print({tx:"late",time:500})]);a.close();
    const b=new TradeArchive(file);b.ingest([print({source:"own",price:3,usd:12,time:2000})]);const rows=b.history("solana","Token",0,3000);expect(rows.events).toHaveLength(2);expect(rows.events[0].price).toBe(3);expect(rows.firstObservedAt).toBe(500);b.close();rmSync(dir,{recursive:true});
  });
});
