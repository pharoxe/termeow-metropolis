import type { TerminalSnapshot } from '../../shared/terminal';
import type { InstrumentRef } from './address';
import { instrumentKey } from './instrument';
type Update={snapshot:TerminalSnapshot|null;connected:boolean;error:string};
type Channel={scope:InstrumentRef;listeners:Set<(v:Update)=>void>;value:Update};
const channels=new Map<string,Channel>();
let stream:EventSource|null=null;
let timer:ReturnType<typeof setTimeout>|undefined;
function reconnect(){
  clearTimeout(timer);
  timer=setTimeout(()=>{
    stream?.close();stream=null;
    if(!channels.size)return;
    stream=new EventSource(`/api/terminal/workspace/stream?scopes=${encodeURIComponent(JSON.stringify([...channels.values()].map(c=>c.scope)))}`);
    const publish=(key:string,value:Update)=>{const c=channels.get(key);if(c){c.value=value;c.listeners.forEach(fn=>fn(value));}};
    stream.addEventListener('snapshot',(event)=>{
      try{const body=JSON.parse((event as MessageEvent).data) as TerminalSnapshot;const key=instrumentKey({chain:body.chain,address:body.token});if(Array.isArray(body.events))publish(key,{snapshot:body,connected:true,error:body.archiveError??''});}catch{/* Ignore malformed frames; the transport will reconnect on failure. */}
    });
    stream.addEventListener('scope-error',(event)=>{try{const body=JSON.parse((event as MessageEvent).data);const key=instrumentKey(body);const c=channels.get(key);if(c)publish(key,{...c.value,connected:false,error:body.error});}catch{}});
    stream.onerror=()=>{for(const [key,c] of channels)publish(key,{...c.value,connected:false});};
  },75);
}
export function subscribeTerminal(scope:InstrumentRef,listener:(v:Update)=>void){
  const key=instrumentKey(scope);let channel=channels.get(key);
  if(!channel){channel={scope,listeners:new Set(),value:{snapshot:null,connected:false,error:''}};channels.set(key,channel);reconnect();}
  channel.listeners.add(listener);listener(channel.value);
  return()=>{channel!.listeners.delete(listener);if(!channel!.listeners.size){channels.delete(key);reconnect();}};
}
