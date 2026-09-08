import { useCallback, useEffect, useRef, useState } from "react";
import type { TradeEvent, TradeHistory, TerminalSnapshot } from "../../shared/terminal";
import type { InstrumentRef } from "../lib/address";

export function useTerminal(instrument:InstrumentRef,range:{from:number;to:number}|null){
  const [events,setEvents]=useState<TradeEvent[]>([]);
  const [snapshot,setSnapshot]=useState<TerminalSnapshot|null>(null);
  const [connected,setConnected]=useState(false);
  const [error,setError]=useState("");
  const [matched,setMatched]=useState(0);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [reload,setReload]=useState(0);
  const [now,setNow]=useState(Date.now());
  const generation=useRef(0);
  const rangeIdentity=useRef("");
  const loadedUntil=useRef<{time:number;id:string}|null>(null);
  const base=`/api/terminal/${instrument.chain}/${instrument.address}`;
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    setEvents([]);setSnapshot(null);setError("");setConnected(false);setNextCursor(null);setMatched(0);
    const stream=new EventSource(`${base}/stream`);let active=true;let last=0;let lastRefresh=0;
    const receive=(message:MessageEvent)=>{
      try{
        const body=JSON.parse(message.data) as TerminalSnapshot;
        if(body.chain!==instrument.chain||body.token!==instrument.address||!Array.isArray(body.events))throw new Error("Invalid live response");
        if(!active)return;setConnected(true);setSnapshot(body);setError(body.archiveError??"");
        // New revisions refresh the visible historical window, including corrections to older events.
        if(body.revision!==last&&Date.now()-lastRefresh>=1500){last=body.revision;lastRefresh=Date.now();setReload(v=>v+1);}
      }catch{if(active)setError("Invalid live data received");}
    };
    stream.addEventListener("snapshot",receive as EventListener);
    stream.onerror=()=>{if(active)setConnected(false);};
    const fallback=setInterval(()=>{if(active)setReload(v=>v+1);},10000);
    return()=>{active=false;stream.close();clearInterval(fallback);};
  },[base,instrument.chain,instrument.address]);
  // Debounce viewport motion; cancel stale requests on interval/instrument changes.
  useEffect(()=>{
    const identity=`${base}:${range?.from??"latest"}:${range?.to??"latest"}`;
    const changedRange=rangeIdentity.current!==identity;
    if(changedRange){rangeIdentity.current=identity;loadedUntil.current=null;}
    const version=++generation.current;const controller=new AbortController();
    const timer=setTimeout(async()=>{
      setLoading(true);
      try{
        const to=Math.min(range?.to??Date.now(),Date.now()),from=Math.max(0,range?.from??to-3600000);
        const response=await fetch(`${base}/history?from=${Math.min(from,to)}&to=${to}&limit=1000`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!response.ok)throw new Error(`History unavailable (${response.status})`);
        const body=await response.json() as TradeHistory;
        if(version!==generation.current)return;
        setEvents(previous=>changedRange||!loadedUntil.current?body.events:[...new Map([...previous,...body.events].map(e=>[e.id,e])).values()].sort((a,b)=>b.time-a.time));
        setMatched(body.matched);
        if(!loadedUntil.current)setNextCursor(body.nextCursor);
        setError(body.error??"");
      }catch(e){if(!controller.signal.aborted)setError(String(e));}
      finally{if(version===generation.current)setLoading(false);}
    },250);
    return()=>{controller.abort();clearTimeout(timer);};
  },[base,range?.from,range?.to,reload]);
  const loadMore=useCallback(async()=>{
    if(!nextCursor||loading)return;const version=generation.current;setLoading(true);
    try{
      const to=Math.min(range?.to??Date.now(),Date.now()),from=Math.max(0,range?.from??to-3600000);
      const response=await fetch(`${base}/history?from=${Math.min(from,to)}&to=${to}&limit=1000&cursor=${encodeURIComponent(nextCursor)}`,{signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error("Unable to load older trades");const body=await response.json() as TradeHistory;
      if(version!==generation.current)return;
      setEvents(prior=>[...new Map([...prior,...body.events].map(e=>[e.id,e])).values()].sort((a,b)=>b.time-a.time));setNextCursor(body.nextCursor);const last=body.events.at(-1);if(last)loadedUntil.current={time:last.time,id:last.id};
    }catch(e){if(version===generation.current)setError(String(e));}finally{if(version===generation.current)setLoading(false);}
  },[base,nextCursor,loading,range]);
  const recent=snapshot?.events??[];
  const newest=recent[0]?.time;
  const healthy=snapshot?.health&&Object.values(snapshot.health).some(h=>h.ok);
  const status=!connected?"RECONNECTING":!healthy?"OFFLINE":newest==null?"WAITING":now-newest>60000?"DELAYED":"PARTIAL LIVE";
  return {events,recent,snapshot,connected,error,matched,nextCursor,loadMore,loading,now,status};
}
