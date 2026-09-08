import { useEffect, useMemo, useSyncExternalStore } from 'react';

type Snapshot<T>={data:T|null;error:string;updatedAt:number};
type Entry<T>={snapshot:Snapshot<T>;listeners:Set<()=>void>;load:()=>Promise<T>;period:number;timer?:ReturnType<typeof setInterval>;pending:boolean;generation:number};
const entries=new Map<string,Entry<unknown>>();
export function resource<T>(key:string,load:()=>Promise<T>,period:number){
  let entry=entries.get(key) as Entry<T>|undefined;
  if(!entry){entry={snapshot:{data:null,error:'',updatedAt:0},listeners:new Set(),load,period,pending:false,generation:0};entries.set(key,entry as Entry<unknown>);}
  const e=entry;
  const refresh=async()=>{
    if(e.pending || !e.listeners.size)return;
    e.pending=true;
    try{const data=await e.load();e.snapshot={data,error:'',updatedAt:Date.now()};}
    catch(error){e.snapshot={...e.snapshot,error:error instanceof Error?error.message:String(error)};}
    finally{e.pending=false;for(const listener of e.listeners)listener();}
  };
  return {getSnapshot:()=>e.snapshot,refresh,subscribe:(listener:()=>void)=>{
    e.listeners.add(listener);e.generation++;
    if(!e.timer){if(!e.snapshot.updatedAt||Date.now()-e.snapshot.updatedAt>=e.period)void refresh();e.timer=setInterval(()=>void refresh(),e.period);}
    return()=>{e.listeners.delete(listener);if(!e.listeners.size){clearInterval(e.timer);e.timer=undefined;const generation=++e.generation;setTimeout(()=>{if(!e.listeners.size&&e.generation===generation)entries.delete(key);},60000);}};
  }};
}
const empty={data:null,error:'',updatedAt:0};
const idle={getSnapshot:()=>empty,subscribe:()=>()=>{},refresh:async()=>{}};
export function useResource<T>(key:string|null,load:()=>Promise<T>,period:number){
  // Every key includes the complete request scope; subscribers for that scope share one timer and request.
  const store=useMemo(()=>key?resource(key,load,period):idle,[key,period]);
  const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot) as Snapshot<T>;
  return {...snapshot,refresh:store.refresh};
}
