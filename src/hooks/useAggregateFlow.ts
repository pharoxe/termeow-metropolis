import type { AggregateFlow } from '../../shared/aggregateFlow';
import type { InstrumentRef } from '../lib/address';
import {useResource} from '../lib/resource';
export function useAggregateFlow(instrument:InstrumentRef,from:number|undefined,to:number|undefined,intervalMs:number) {
  const url=from==null||to==null?null:`/api/terminal/${instrument.chain}/${instrument.address}/aggregate?from=${from}&to=${to}&intervalMs=${intervalMs}`;
  return useResource<AggregateFlow>(url,async()=>{
    const response=await fetch(url!,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Aggregate unavailable (${response.status})`);
    return response.json();
  },5000);
}
