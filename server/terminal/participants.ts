import {DatabaseSync} from 'node:sqlite';
import type {ParticipantSnapshot} from '../../shared/participant.js';
import type {Chain} from '../../shared/wire.js';
import {chainKey} from '../../shared/terminal.js';
export type ParticipantResult=Pick<ParticipantSnapshot,'balanceUsd'|'balanceComplete'|'handle'|'followers'|'protocol'|'error'>;
export class ParticipantWorker {
  private db:DatabaseSync;
  private busy=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(file:string,private loader:(chain:Chain,wallet:string)=>Promise<ParticipantResult>,readonly refreshMs=600000,private now=Date.now){
    this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS participants (key TEXT PRIMARY KEY, requested INTEGER, due INTEGER, body TEXT)');
  }
  watch(chain:Chain,wallets:string[]):ParticipantSnapshot[]{
    const now=this.now();
    return [...new Set(wallets.map(w=>chainKey(chain,w)))].slice(0,32).map(wallet=>{
      const key=`${chain}:${wallet}`;
      const old=this.db.prepare('SELECT body FROM participants WHERE key=?').get(key) as {body:string}|undefined;
      const snapshot:ParticipantSnapshot=old?JSON.parse(old.body):{chain,wallet,checkedAt:null,attemptedAt:null,nextCheckAt:now,status:'queued',balanceUsd:null,balanceComplete:false,handle:null,followers:null,protocol:'unknown',socialOwnership:'unverified',error:null};
      this.db.prepare('INSERT INTO participants VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET requested=excluded.requested').run(key,now,snapshot.nextCheckAt,JSON.stringify(snapshot));
      return snapshot;
    });
  }
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      // Only the 32 most recently requested wallets stay active; closed screens expire after 24h.
      const row=this.db.prepare('SELECT key,body FROM participants WHERE key IN (SELECT key FROM participants WHERE requested>? ORDER BY requested DESC LIMIT 32) AND due<=? ORDER BY due LIMIT 1').get(this.now()-86400000,this.now()) as {key:string;body:string}|undefined;
      if(!row)return;
      const old=JSON.parse(row.body) as ParticipantSnapshot;
      const attemptedAt=this.now();
      this.db.prepare('UPDATE participants SET body=? WHERE key=?').run(JSON.stringify({...old,status:'checking',attemptedAt}),row.key);
      let next:ParticipantSnapshot;
      try{
        const result=await this.loader(old.chain,old.wallet);
        next={...old,...result,attemptedAt,checkedAt:this.now(),nextCheckAt:this.now()+this.refreshMs,status:result.balanceComplete?'fresh':result.balanceUsd!=null?'partial':'unavailable'};
      }catch{
        next={...old,attemptedAt,nextCheckAt:this.now()+Math.min(this.refreshMs,300000),status:'error',error:'Snapshot refresh failed; previous observation retained'};
      }
      this.db.prepare('UPDATE participants SET due=?,body=? WHERE key=?').run(next.nextCheckAt,JSON.stringify(next),row.key);
    }finally{this.busy=false;}
  }
  start(){if(!this.timer){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},10000);this.timer.unref();}}
  close(){if(this.timer)clearInterval(this.timer);this.db.close();}
}
