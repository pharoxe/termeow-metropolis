import { participantWorker } from "../terminal/participantLive.js";
import { Router } from "express";
import { z } from "zod";
import type { CapturedCandles, TerminalSnapshot, TradeEvent } from "../../shared/terminal.js";
import { printCandles } from "../flow/candles.js";
import { isLaunchpadRow } from "../flow/registry.js";
import { bindArchive, tradeArchive } from "../terminal/live.js";
import { flowParamsSchema, liveDeps } from "./flow.js";

export const terminalRouter = Router();
terminalRouter.post("/participants/watch",(req,res,next)=>{
  try {
    const body=z.object({chain:z.enum(["solana","robinhood"]),wallets:z.array(z.string()).max(32)}).parse(req.body);
    for(const wallet of body.wallets) flowParamsSchema.parse({chain:body.chain,address:wallet});
    res.json({snapshots:participantWorker.watch(body.chain,body.wallets),refreshMs:participantWorker.refreshMs,observedAt:Date.now()});
  }catch(e){next(e);}
});
const querySchema = z.object({ from:z.coerce.number().int().nonnegative().optional(), to:z.coerce.number().int().nonnegative().optional(), limit:z.coerce.number().int().min(1).max(2000).default(500), cursor:z.string().max(1000).optional() });
async function prepare(params: unknown) {
  const scope = flowParamsSchema.parse(params);
  const registry = await liveDeps.registry(scope.chain,scope.address);
  bindArchive(scope.chain,scope.address,registry.pairs);
  liveDeps.collector.subscribe(scope.chain,scope.address,registry.pairs.filter(p => !isLaunchpadRow(p)));
  return {...scope, pairs:registry.pairs};
}
function snapshot(chain: "solana"|"robinhood", address:string):TerminalSnapshot {
  const history=tradeArchive.history(chain,address,0,Date.now(),200);
  return { chain,token:address,events:history.events,revision:history.revision,observedAt:Date.now(),health:liveDeps.collector.status?.(chain,address).feedHealth??null,archiveError:tradeArchive.error };
}
terminalRouter.get("/:chain/:address/history",async(req,res,next)=>{
  try {
    const {chain,address}=flowParamsSchema.parse(req.params);
    const query=querySchema.parse(req.query); const to=query.to??Date.now(),from=query.from??Math.max(0,to-86400_000);
    if(from>to) {res.status(400).json({error:"from must be before to"});return;}
    // Durable reads do not depend on a provider being available.
    try {res.json(tradeArchive.history(chain,address,from,to,query.limit,query.cursor));} catch {res.status(400).json({error:"Invalid history cursor"});}
  }catch(e){next(e);}
});
terminalRouter.get("/:chain/:address/candles",(req,res,next)=>{
  try{
    const {chain,address}=flowParamsSchema.parse(req.params);
    const interval=z.enum(["5s","15s","1m"]).parse(req.query.interval??"15s");
    const rows=tradeArchive.history(chain,address,Math.max(0,Date.now()-86400_000),Date.now(),20000);
    // Wallet-net transfer observations duplicate pool activity and cannot be added to pool volume.
    const events=rows.events.filter(e=>e.granularity!=="wallet-net");
    const prints=events.map(e=>({chain:e.chain,pair:e.pair,tx:e.id,time:e.time,side:e.side,usd:e.usd,price:e.price,source:e.source as "own"}));
    const priced=events.filter(e=>e.price!=null&&e.price>0);
    const sources:Record<string,number>={}; for(const e of priced) sources[e.source]=(sources[e.source]??0)+1;
    const body:CapturedCandles={chain,address,interval,candles:printCandles(prints,{"5s":5000,"15s":15000,"1m":60000}[interval]),revision:rows.revision,observedAt:rows.observedAt,source:"own tape",spanMs:priced.length?priced[0].time-priced.at(-1)!.time:0,prints:events.length,priced:priced.length,firstPrintAt:events.at(-1)?.time??null,pricedBySource:sources,...(rows.nextCursor?{error:"Captured history limited to the latest 20,000 observations"}:{})};
    res.json(body);
  }catch(e){next(e);}
});
terminalRouter.get("/:chain/:address/aggregate",(req,res,next)=>{
  try {
    const {chain,address}=flowParamsSchema.parse(req.params);
    const q=z.object({from:z.coerce.number().int().nonnegative(),to:z.coerce.number().int().nonnegative(),intervalMs:z.coerce.number().int().min(5000).max(86400000)}).parse(req.query);
    if(q.from>q.to || (q.to-q.from)/q.intervalMs>10000){res.status(400).json({error:"Invalid range or more than 10,000 buckets requested"});return;}
    res.json(tradeArchive.aggregate(chain,address,q.from,q.to,q.intervalMs));
  }catch(e){next(e);}
});
let connections=0;
const workspaceScopes=new Map<string,{refs:number;scope:ReturnType<typeof flowParamsSchema.parse>;ready:ReturnType<typeof prepare>|null;lastTouch:number}>();
terminalRouter.get('/workspace/stream',async(req,res,next)=>{
  let scopes:Array<{chain:'solana'|'robinhood';address:string}>;
  try{scopes=z.array(flowParamsSchema).min(1).max(4).parse(JSON.parse(String(req.query.scopes))).filter((s,i,all)=>all.findIndex(x=>x.chain===s.chain&&x.address===s.address)===i);}catch(e){res.status(400).json({error:'Invalid workspace scopes'});return;}
  if(connections>=16){res.status(503).json({error:'Live connection limit reached'});return;}
  connections++;let closed=false;
  const keys=scopes.map(s=>`${s.chain}:${s.address}`);
  for(let i=0;i<scopes.length;i++){const existing=workspaceScopes.get(keys[i]);if(existing)existing.refs++;else workspaceScopes.set(keys[i],{refs:1,scope:scopes[i],ready:null,lastTouch:0});}
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.flushHeaders();res.write('retry: 2000\n\n');
  const revisions=new Map<string,string>();
  const timer=setInterval(()=>{
    if(closed||res.writableNeedDrain)return;
    for(const key of keys){
      const entry=workspaceScopes.get(key);if(!entry)continue;
      if(Date.now()-entry.lastTouch>10000){entry.lastTouch=Date.now();if(!entry.ready)entry.ready=prepare(entry.scope);void entry.ready.then(scope=>{if(entry.refs>0)liveDeps.collector.subscribe(scope.chain,scope.address,scope.pairs.filter(p=>!isLaunchpadRow(p)));}).catch(()=>{entry.ready=null;if(!closed)res.write(`event: scope-error\ndata: ${JSON.stringify({...entry.scope,error:'Pool source unavailable; retrying'})}\n\n`);});}
      const revision=`${tradeArchive.revision()}:${Math.floor(Date.now()/10000)}`;
      if(revisions.get(key)===revision)continue;
      try{const body=snapshot(entry.scope.chain,entry.scope.address);res.write(`event: snapshot\ndata: ${JSON.stringify(body)}\n\n`);revisions.set(key,revision);}catch{/* Retry at the next tick. */}
    }
  },1000);timer.unref();
  res.on('close',()=>{closed=true;connections--;clearInterval(timer);for(const key of keys){const entry=workspaceScopes.get(key);if(entry&&--entry.refs===0)workspaceScopes.delete(key);}});
});
terminalRouter.get("/:chain/:address/stream",async(req,res,next)=>{
  if(connections>=16){res.status(503).json({error:"Live connection limit reached"});return;}
  connections++;
  let closed=false; let timer:ReturnType<typeof setInterval>|undefined;
  res.on("close",()=>{closed=true;connections--;if(timer)clearInterval(timer);});
  try{
    const scope=await prepare(req.params); if(closed)return;
    res.setHeader("Content-Type","text/event-stream");res.setHeader("Cache-Control","no-cache, no-transform");res.setHeader("X-Accel-Buffering","no");res.flushHeaders();
    res.write("retry: 2000\n\n");
    let revision=-1,heartbeat=0;
    const send=()=>{
      if(closed||res.writableNeedDrain)return;
      try {
      // Periodic complete snapshots make reconnect recovery idempotent; historical ranges are revalidated by the client.
      if(tradeArchive.revision()!==revision||Date.now()-heartbeat>=10000){
        const body=snapshot(scope.chain,scope.address);revision=body.revision;heartbeat=Date.now();
        res.write(`id: ${revision}\nevent: snapshot\ndata: ${JSON.stringify(body)}\n\n`);
      }
      liveDeps.collector.subscribe(scope.chain,scope.address,scope.pairs.filter(p=>!isLaunchpadRow(p)));
      } catch {res.write(`event: feed-error\ndata: {"error":"Archive temporarily unavailable"}\n\n`);}
    };
    send();timer=setInterval(send,250);timer.unref();
  }catch(e){if(!closed)next(e);}
});
