import {describe,it,expect,vi} from 'vitest';
import {ParticipantWorker,type ParticipantResult} from './participants.js';
const value:ParticipantResult={balanceUsd:100000,balanceComplete:true,handle:null,followers:null,protocol:'unknown',error:null};
describe('participant refresh worker',()=>{
  it('captures a baseline and only refreshes after its due time',async()=>{
    let now=1000;const load=vi.fn(async()=>value),worker=new ParticipantWorker(':memory:',load,600000,()=>now);
    expect(worker.watch('solana',['Wallet'])[0].status).toBe('queued');await worker.tick();
    expect(worker.watch('solana',['Wallet'])[0]).toMatchObject({status:'fresh',checkedAt:1000,balanceUsd:100000,nextCheckAt:601000});
    await worker.tick();expect(load).toHaveBeenCalledTimes(1);now=601000;await worker.tick();expect(load).toHaveBeenCalledTimes(2);worker.close();
  });
  it('retains previous data on failure without presenting it as fresh',async()=>{
    let now=1000;const load=vi.fn().mockResolvedValueOnce(value).mockRejectedValueOnce(new Error('rpc failure'));
    const worker=new ParticipantWorker(':memory:',load,600000,()=>now);worker.watch('solana',['Wallet']);await worker.tick();now=601000;await worker.tick();
    expect(worker.watch('solana',['Wallet'])[0]).toMatchObject({status:'error',balanceUsd:100000,checkedAt:1000,attemptedAt:601000});worker.close();
  });
  it('does not classify partial balances as fresh and preserves Solana case',async()=>{
    const worker=new ParticipantWorker(':memory:',async()=>({...value,balanceComplete:false}),600000,()=>1000);
    worker.watch('solana',['Wallet','wallet']);await worker.tick();const rows=worker.watch('solana',['Wallet','wallet']);
    expect(rows.map(r=>r.wallet)).toEqual(['Wallet','wallet']);expect(rows.filter(r=>r.status==='partial')).toHaveLength(1);worker.close();
  });
  it('does not overlap refreshes',async()=>{
    let finish!:(result:ParticipantResult)=>void;const load=vi.fn(()=>new Promise<ParticipantResult>(r=>finish=r));
    const worker=new ParticipantWorker(':memory:',load,600000,()=>1000);worker.watch('solana',['Wallet','Wallet2']);const first=worker.tick();await worker.tick();expect(load).toHaveBeenCalledTimes(1);finish(value);await first;worker.close();
  });
});
