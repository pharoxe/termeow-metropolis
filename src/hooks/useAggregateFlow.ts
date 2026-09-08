import { useEffect, useState } from 'react';
import type { AggregateFlow } from '../../shared/aggregateFlow';
import type { InstrumentRef } from '../lib/address';
export function useAggregateFlow(instrument:InstrumentRef,from:number|undefined,to:number|undefined,intervalMs:number) {
  const [data,setData]=useState<AggregateFlow|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    setData(null);setError('');
    if(from==null||to==null)return;
    const controller=new AbortController();let busy=false;
    const load=async()=>{
      if(busy)return;busy=true;
      try {
        const response=await fetch(`/api/terminal/${instrument.chain}/${instrument.address}/aggregate?from=${from}&to=${to}&intervalMs=${intervalMs}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!response.ok)throw new Error(`Aggregate unavailable (${response.status})`);
        const value=await response.json() as AggregateFlow;
        if(!controller.signal.aborted){setData(value);setError('');}
      }catch(e){if(!controller.signal.aborted)setError(String(e));}finally{busy=false;}
    };
    const start=setTimeout(load,250),timer=setInterval(load,5000);
    return()=>{controller.abort();clearTimeout(start);clearInterval(timer);};
  },[instrument.chain,instrument.address,from,to,intervalMs]);
  return {data,error};
}
