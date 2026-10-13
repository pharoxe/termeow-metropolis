import {describe,it,expect,vi} from 'vitest';
import {ParticipantWorker,type ParticipantResult} from './participants.js';
const W='0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1',W2='0x0a6ebed0155edb4b21d92ad02897a626cd90119e';
const value:ParticipantResult={balanceUsd:100000,balanceComplete:true,handle:null,followers:null,protocol:'unknown',error:null};
describe('participant refresh worker',()=>{
  it('captures a baseline and only refreshes after its due time',async()=>{
    let now=1000;const load=vi.fn(async()=>value),worker=new ParticipantWorker(':memory:',load,600000,()=>now);
    expect(worker.watch('monad',[W])[0].status).toBe('queued');await worker.tick();
    expect(worker.watch('monad',[W])[0]).toMatchObject({status:'fresh',checkedAt:1000,balanceUsd:100000,nextCheckAt:601000});
    await worker.tick();expect(load).toHaveBeenCalledTimes(1);now=601000;await worker.tick();expect(load).toHaveBeenCalledTimes(2);worker.close();
  });
  it('retains previous data on failure without presenting it as fresh',async()=>{
    let now=1000;const load=vi.fn().mockResolvedValueOnce(value).mockRejectedValueOnce(new Error('rpc failure'));
    const worker=new ParticipantWorker(':memory:',load,600000,()=>now);worker.watch('monad',[W]);await worker.tick();now=601000;await worker.tick();
    expect(worker.watch('monad',[W])[0]).toMatchObject({status:'error',balanceUsd:100000,checkedAt:1000,attemptedAt:601000});worker.close();
  });
  it('does not classify partial balances as fresh and folds Monad address case',async()=>{
    const worker=new ParticipantWorker(':memory:',async()=>({...value,balanceComplete:false}),600000,()=>1000);
    worker.watch('monad',[W,W.toUpperCase().replace('0X','0x')]);await worker.tick();const rows=worker.watch('monad',[W,W.toUpperCase().replace('0X','0x')]);
    expect(rows.map(r=>r.wallet)).toEqual([W]);expect(rows.filter(r=>r.status==='partial')).toHaveLength(1);worker.close();
  });
  it('does not overlap refreshes',async()=>{
    let finish!:(result:ParticipantResult)=>void;const load=vi.fn(()=>new Promise<ParticipantResult>(r=>finish=r));
    const worker=new ParticipantWorker(':memory:',load,600000,()=>1000);worker.watch('monad',[W,W2]);const first=worker.tick();await worker.tick();expect(load).toHaveBeenCalledTimes(1);finish(value);await first;worker.close();
  });
});
