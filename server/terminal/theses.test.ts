import {describe,it,expect} from 'vitest';
import {ThesisCollector,ThesisStore} from './theses';
import {normalizeThesisPage} from './thesisSource';
import {CuBudget} from './cuBudget';
const token='So11111111111111111111111111111111111111112',now=1800000000000;
const raw=(items:unknown[])=>({tokenAddress:token,tokenNetwork:'sol',hasMore:false,nextBefore:null,items});
const post=(id:string,time:number,text='A thesis')=>({id,authorHandle:'trader',authorId:'one',thesis:text,fomoCreatedAt:time});
describe('thesis source and aggregate',()=>{
  it('deduplicates deliveries and edits while comparing equal windows',()=>{
    const store=new ThesisStore(':memory:');
    try{
      store.watch('solana',token,now);
      const page=normalizeThesisPage(raw([post('1',now-1000),post('2',now-2000),post('3',now-3700000)]),'solana',token,now);
      store.completePage(store.due(now)!,page,now);store.ingest(page.items);
      store.ingest([{...page.items[0],text:'Edited thesis',observedAt:now+1}]);
      const summary=store.summary('solana',token,'1h',now,true);
      expect(summary.count).toBe(2);expect(summary.previousCount).toBe(1);
      expect(summary.change).toBe(1);expect(summary.ratePerHour).toBe(2);
      expect(summary.uniqueAuthors).toBe(1);expect(summary.percentChange).toBeNull();
      expect(summary.items[0].text).toBe('Edited thesis');expect(summary.status).toBe('ready');
    }finally{store.close();}
  });
  it('does not turn an empty harvesting response into complete zero coverage',()=>{
    const store=new ThesisStore(':memory:');try{
      store.watch('solana',token,now);
      expect(store.summary('solana',token,'24h',now,false).count).toBeNull();
      store.completePage(store.due(now)!,normalizeThesisPage(raw([]),'solana',token,now),now);
      const summary=store.summary('solana',token,'24h',now,true);
      expect(summary.status).toBe('partial');expect(summary.change).toBeNull();expect(summary.ratePerHour).toBeNull();
    }finally{store.close();}
  });
  it('rejects ambiguous networks and prevents invalid posts establishing coverage',()=>{
    expect(()=>normalizeThesisPage({...raw([post('1',now)]),tokenNetwork:'base'},'solana',token,now)).toThrow();
    const page=normalizeThesisPage(raw([post('1',now+1000)]),'solana',token,now);
    expect(page.skipped).toBe(1);expect(page.items).toHaveLength(0);
  });

  it('defers a page it cannot afford instead of spending or failing the job',async()=>{
    const store=new ThesisStore(':memory:'),meter=new CuBudget(':memory:',{grant:250000,share:0.1,burst:0,label:'theses'});
    try{
      store.watch('solana',token,now);
      meter.record(now,'thesisPage',meter.budget); // the month's share already spent
      let calls=0;
      const collector=new ThesisCollector(store,async()=>{calls++;return normalizeThesisPage(raw([post('1',now)]),'solana',token,now);},()=>now,meter);
      await collector.tick();
      expect(calls).toBe(0);
      expect(collector.state().deferred).toBe(1);
      expect(meter.state(now).spent).toBe(meter.budget);
      const summary=store.summary('solana',token,'24h',now,true);
      expect(summary.error).toContain('budget');
      expect(summary.count).toBeNull();
      // With the pace released the same collector pays for the page and clears the deferral message.
      const later=now+40*86400000;
      const paced=new ThesisCollector(store,async()=>{calls++;return normalizeThesisPage(raw([post('1',later)]),'solana',token,later);},()=>later,meter);
      store.watch('solana',token,later);
      await paced.tick();
      expect(calls).toBe(1);
      expect(meter.state(later).spent).toBe(250);
      expect(store.summary('solana',token,'24h',later,true).error).toBeNull();
    }finally{store.close();meter.close();}
  });
});
