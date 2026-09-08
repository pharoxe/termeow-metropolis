import {useEffect,useMemo,useState} from 'react';
import type {TradeEvent} from '../../shared/terminal';
import type {ParticipantSnapshot} from '../../shared/participant';
import type {Chain} from '../../shared/wire';
export function useParticipants(chain:Chain,events:TradeEvent[],selected:TradeEvent|null,enabled=true){
  const wallets=useMemo(()=>JSON.stringify([...new Set([selected?.wallet,...[...events].sort((a,b)=>(b.usd??0)-(a.usd??0)).filter(e=>(e.usd??0)>=500||Boolean(e.handle)).map(e=>e.wallet)].filter((w):w is string=>Boolean(w)))].slice(0,32).sort()),[events,selected?.wallet]);
  const [snapshots,setSnapshots]=useState<ParticipantSnapshot[]>([]);
  const [error,setError]=useState('');
  const [refreshMs,setRefreshMs]=useState(600000);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();let busy=false;setSnapshots([]);
    const load=async()=>{
      if(busy)return;busy=true;
      try{
        const response=await fetch('/api/terminal/participants/watch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain,wallets:JSON.parse(wallets)}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!response.ok)throw new Error('Participant baseline unavailable');
        const body=await response.json();
        if(!controller.signal.aborted){setSnapshots(body.snapshots);setRefreshMs(body.refreshMs);setError('');}
      }catch(e){if(!controller.signal.aborted)setError(String(e));}finally{busy=false;}
    };
    void load();const timer=setInterval(load,15000);
    return()=>{controller.abort();clearInterval(timer);};
  },[chain,wallets,enabled]);
  return {snapshots,error,refreshMs};
}
