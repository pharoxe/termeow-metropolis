import {it,expect,vi} from 'vitest';
import {subscribeTerminal} from './workspaceStream';
it('multiplexes unique scopes and keeps shared subscribers alive',async()=>{
  vi.useFakeTimers();
  const sources:FakeSource[]=[];
  class FakeSource{
    listeners=new Map<string,(event:{data:string})=>void>();
    close=vi.fn();onerror:(()=>void)|null=null;
    constructor(public url:string){sources.push(this);}
    addEventListener(name:string,fn:(event:{data:string})=>void){this.listeners.set(name,fn);}
  }
  vi.stubGlobal('EventSource',FakeSource);
  const scope={chain:'solana' as const,address:'So11111111111111111111111111111111111111112'};
  const listener=vi.fn(),other=vi.fn();
  const offA=subscribeTerminal(scope,listener),offB=subscribeTerminal(scope,other);
  try{
    await vi.advanceTimersByTimeAsync(75);
    expect(sources).toHaveLength(1);
    expect(JSON.parse(new URL(sources[0].url,'http://localhost').searchParams.get('scopes')!)).toEqual([scope]);
    sources[0].listeners.get('snapshot')!({data:JSON.stringify({chain:scope.chain,token:scope.address,events:[]})});
    expect(listener.mock.lastCall?.[0].connected).toBe(true);expect(other.mock.lastCall?.[0].connected).toBe(true);
    offA();await vi.advanceTimersByTimeAsync(100);expect(sources[0].close).not.toHaveBeenCalled();
    offB();await vi.advanceTimersByTimeAsync(75);expect(sources[0].close).toHaveBeenCalledOnce();
  }finally{offA();offB();await vi.advanceTimersByTimeAsync(75);vi.unstubAllGlobals();vi.useRealTimers();}
});
