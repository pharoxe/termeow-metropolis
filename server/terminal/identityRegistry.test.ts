import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {BoardCollector,IdentityRegistry} from './identityRegistry';
import {FomoscanError,normalizeFomoProfile,normalizeFomoscanTraders,normalizePumpProfile,normalizePumpTraders} from './fomoscanBoards';
import {CuBudget} from './cuBudget';
import type {BoardSnapshot} from '../../shared/identity';

const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`./__fixtures__/fomoscan/${name}.json`,import.meta.url),'utf8'));
const NOW=Date.UTC(2026,8,8,15,30);
const budget=(over:Partial<{grant:number;share:number;burst:number}>={})=>new CuBudget(':memory:',{grant:250000,share:0.1,burst:5000,...over});

describe('FomoScan board normalizers',()=>{
  it('reads the on-chain sweep board as identities plus a ranking that names its population',()=>{
    const snapshot=normalizeFomoscanTraders(fixture('traders-fomoscan-24h'),NOW);
    expect(snapshot.board).toBe('fomoscan-traders');
    expect(snapshot.walletsRanked).toBe(316007);
    expect(snapshot.identities).toHaveLength(3);
    const first=snapshot.identities[0];
    expect(first.handle).toBe('0xdedrater');
    expect(first.displayName).toBe('Dedrater');
    expect(first.chain).toBe('solana');
    expect(first.source).toBe('fomoscan-board');
    const ranking=snapshot.rankings[0];
    expect(ranking.realizedPnlUsd).toBe(26005.26);
    expect(ranking.unrealizedPnlUsd).toBeNull();
    expect(ranking.winRate).toBe(0.5);
    expect(ranking.avgHoldSeconds).toBe(29470);
  });

  it('keeps the pump board\'s unrealized leg separate from its realized one',()=>{
    const snapshot=normalizePumpTraders(fixture('pump-traders-weekly'),NOW);
    const top=snapshot.rankings[0];
    // The headline number is a paper gain: this wallet's realized leg is negative.
    expect(top.pnlUsd).toBeGreaterThan(1000000);
    expect(top.realizedPnlUsd).toBeLessThan(0);
    expect(top.unrealizedPnlUsd).toBeGreaterThan(1000000);
    expect(snapshot.walletsRanked).toBeNull();
    expect(snapshot.identities[0].handle).toBe('weeshark41081');
  });

  it('turns one FOMO profile into an address on each chain under a single handle',()=>{
    const identities=normalizeFomoProfile({
      id:'aefe2ddd-c580-5245-a2f5-e4ed62f7ef10',handle:'frankdegods',name:'frank',
      twitter:'https://x.com/frankdegods',
      solanaAddress:'498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ',
      evmAddress:'0x696D1265C8FC4F14797ABEBFAE3C43EBFA9D8E28'
    },NOW);
    expect(identities.map((i)=>i.chain)).toEqual(['solana','robinhood']);
    // Robinhood addresses are compared lower-cased; Solana base58 is case-sensitive and must survive intact.
    expect(identities[1].wallet).toBe('0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28');
    expect(identities[0].wallet).toBe('498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ');
    expect(identities.every((i)=>i.userId===identities[0].userId)).toBe(true);
  });

  it('never invents a name from a nameless row',()=>{
    const board=fixture('pump-traders-weekly');
    board.entries[0].username=null;board.entries[1].username='   ';
    const snapshot=normalizePumpTraders(board,NOW);
    expect(snapshot.identities).toHaveLength(1);
    expect(snapshot.rankings).toHaveLength(3);
    expect(normalizePumpProfile({wallet:'3jWTgYPG5s7WfaRvppPBXio4hHQxg18fLUkV2z5covSQ',username:null},NOW)).toBeNull();
  });
});

describe('identity registry',()=>{
  it('prefers a resolved profile over a board listing and keeps the first sighting',()=>{
    const registry=new IdentityRegistry(':memory:');
    try{
      registry.record(normalizePumpTraders(fixture('pump-traders-weekly'),NOW),NOW);
      const wallet='3jWTgYPG5s7WfaRvppPBXio4hHQxg18fLUkV2z5covSQ';
      expect(registry.lookup('solana',wallet)?.source).toBe('pump-board');
      expect(registry.upsert({chain:'solana',wallet,handle:'renamed',displayName:'Renamed',twitter:null,
        followers:12,userId:'user-1',source:'fomo-profile',observedAt:NOW+1000})).toBe(true);
      expect(registry.lookup('solana',wallet)?.handle).toBe('renamed');
      // A later board sweep must not overwrite the stronger source with a stale listing.
      expect(registry.upsert({chain:'solana',wallet,handle:'weeshark41081',displayName:null,twitter:null,
        followers:null,userId:null,source:'pump-board',observedAt:NOW+2000})).toBe(false);
      expect(registry.lookup('solana',wallet)?.handle).toBe('renamed');
    }finally{registry.close();}
  });

  it('answers a handle with every chain it holds an address on',()=>{
    const registry=new IdentityRegistry(':memory:');
    try{
      for(const identity of normalizeFomoProfile({id:'u1',handle:'frankdegods',name:'frank',twitter:null,
        solanaAddress:'498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ',
        evmAddress:'0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28'},NOW))registry.upsert(identity);
      expect(registry.byHandle('FrankDeGods').map((i)=>i.chain)).toEqual(['robinhood','solana']);
    }finally{registry.close();}
  });

  it('counts named coverage against the wallets this server actually saw',()=>{
    const registry=new IdentityRegistry(':memory:');
    try{
      registry.record(normalizeFomoscanTraders(fixture('traders-fomoscan-24h'),NOW),NOW);
      const known=fixture('traders-fomoscan-24h').entries[0].wallet as string;
      const coverage=registry.coverage({observed:{solana:[known,'unknown-wallet-a','unknown-wallet-b'],robinhood:[]}});
      expect(coverage.identities).toBe(3);
      expect(coverage.observedWallets?.solana).toEqual({seen:3,named:1});
      expect(coverage.observedWallets?.robinhood).toEqual({seen:0,named:0});
      expect(coverage.boards[0].walletsRanked).toBe(316007);
      // Both clocks and the sweep's own coverage reach the page: capturedAt is upstream's sample instant, observedAt
      // this server's read of it, and the live boards hold them 4.8 days apart.
      expect(coverage.boards[0].coverage).toBe(1);
      expect(coverage.boards[0].capturedAt).toBe(1788464524000);
      expect(coverage.boards[0].observedAt).toBe(NOW);
      // Only the chains the registry holds rows for: robinhood is absent, never 0, because nothing named one.
      expect(coverage.byChain).toEqual({solana:3});
      expect(coverage.bySource['fomoscan-board']).toBe(3);
    }finally{registry.close();}
  });

  it('replaces the stored ranking rather than interleaving two capture instants',()=>{
    const registry=new IdentityRegistry(':memory:');
    const snapshot=(capturedAt:number,wallets:string[]):BoardSnapshot=>({
      board:'fomoscan-traders',window:'24h',capturedAt,count:wallets.length,walletsRanked:316007,coverage:1,complete:true,
      identities:[],
      rankings:wallets.map((wallet,index)=>({
        board:'fomoscan-traders' as const,window:'24h',rank:index+1,chain:'solana' as const,wallet,capturedAt,
        pnlUsd:null,realizedPnlUsd:null,unrealizedPnlUsd:null,returnPct:null,volumeUsd:null,trades:null,
        uniqueTokens:null,winRate:null,avgHoldSeconds:null,tokensCreated:null,walletFirstSeenAt:null
      }))
    });
    try{
      registry.record(snapshot(1000,['W1','W2','W3']),1000);
      // The 24h board is a rolling window over 316,007 wallets and turns over most of its top rows between daily
      // reads. The ranking rows are keyed on the wallet, so without a delete yesterday's W2 and W3 survive at ranks 2
      // and 3 beside today's W4 and W5 — six rows, every rank printed twice, from two capture instants.
      registry.record(snapshot(2000,['W1','W4','W5']),2000);
      const rows=registry.ranked('fomoscan-traders','24h');
      expect(rows.map((row)=>row.wallet)).toEqual(['W1','W4','W5']);
      expect(rows.map((row)=>row.rank)).toEqual([1,2,3]);
      expect([...new Set(rows.map((row)=>row.capturedAt))]).toEqual([2000]);
    }finally{registry.close();}
  });
});

describe('board collector',()=>{
  const snapshot=(now:number)=>normalizeFomoscanTraders(fixture('traders-fomoscan-24h'),now);
  const requests=[{board:'fomoscan-traders' as const,window:'24h'},{board:'pump-traders' as const,window:'weekly'}];

  it('reads each board once per interval and charges the list price',async()=>{
    const registry=new IdentityRegistry(':memory:'),meter=budget();
    try{
      let calls=0;
      const collector=new BoardCollector(registry,meter,requests,async()=>{calls++;return snapshot(NOW);},86400000);
      expect(await collector.tick(NOW)).toBe(true);
      expect(await collector.tick(NOW)).toBe(true);
      // Both boards are now fresh, so a third tick spends nothing.
      expect(await collector.tick(NOW+1000)).toBe(false);
      expect(calls).toBe(2);
      expect(meter.state(NOW).spent).toBe(500);
      expect(await collector.tick(NOW+86400001)).toBe(true);
    }finally{registry.close();meter.close();}
  });

  it('stops when the budget refuses and reports it rather than retrying',async()=>{
    const registry=new IdentityRegistry(':memory:'),meter=budget({burst:0});
    try{
      let calls=0;
      meter.record(NOW,'board',meter.budget); // the month's whole share already spent
      const collector=new BoardCollector(registry,meter,requests,async()=>{calls++;return snapshot(NOW);},86400000);
      expect(await collector.tick(NOW)).toBe(false);
      expect(calls).toBe(0);
      expect(collector.state().refused).toBe(1);
      expect(meter.state(NOW).spent).toBe(meter.budget);
    }finally{registry.close();meter.close();}
  });

  it('does not charge for a call the provider refused',async()=>{
    const registry=new IdentityRegistry(':memory:'),meter=budget();
    try{
      const refused=new BoardCollector(registry,meter,requests,
        async()=>{throw new FomoscanError('FomoScan units exhausted for this billing period',402,false);},86400000);
      expect(await refused.tick(NOW)).toBe(false);
      expect(meter.state(NOW).spent).toBe(0);
      expect(refused.state().lastError).toContain('exhausted');
      const served=new BoardCollector(registry,meter,requests,
        async()=>{throw new FomoscanError('FomoScan returned 500',500,true);},86400000);
      expect(await served.tick(NOW)).toBe(false);
      expect(meter.state(NOW).spent).toBe(250);
    }finally{registry.close();meter.close();}
  });

  it('surfaces the budget and the refusal count on the coverage record',async()=>{
    const registry=new IdentityRegistry(':memory:'),meter=budget({burst:0});
    try{
      meter.record(NOW,'board',meter.budget);
      const collector=new BoardCollector(registry,meter,requests,async()=>snapshot(NOW) as BoardSnapshot,86400000);
      await collector.tick(NOW);
      const coverage=registry.coverage({budget:meter.state(NOW),...collector.state(),refusedForBudget:collector.state().refused});
      expect(coverage.refusedForBudget).toBe(1);
      expect(coverage.budget?.budget).toBe(25000);
      expect(coverage.identities).toBe(0);
    }finally{registry.close();meter.close();}
  });

  it('hands a ranked row the name the registry already holds, and null when it holds none',()=>{
    const registry=new IdentityRegistry(':memory:');
    try{
      registry.record(normalizeFomoscanTraders(fixture('traders-fomoscan-24h'),NOW),NOW);
      const ranked=registry.ranked('fomoscan-traders','24h');
      // The board deposits the identity and the ranking in the same call, so every named row must come back named.
      expect(ranked[0].identity?.handle).toBe('0xdedrater');
      expect(ranked[0].identity?.displayName).toBe('Dedrater');
      expect(ranked[0].identity?.followers).toBe(10695);
      expect(ranked[0].rank).toBe(1);
      expect(ranked[0].realizedPnlUsd).toBe(26005.26);
      // A ranked wallet no board has named keeps its row and reports null rather than being dropped or guessed at.
      const board=fixture('traders-fomoscan-24h');
      board.entries[0].handle=null;board.entries[0].displayName=null;
      const anonymous=new IdentityRegistry(':memory:');
      anonymous.record(normalizeFomoscanTraders(board,NOW),NOW);
      const rows=anonymous.ranked('fomoscan-traders','24h');
      expect(rows).toHaveLength(3);
      expect(rows[0].identity).toBeNull();
      expect(rows[0].wallet).toBe(board.entries[0].wallet);
      anonymous.close();
    }finally{registry.close();}
  });
});
