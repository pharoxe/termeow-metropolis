import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import type {Chain} from '../../shared/wire.js';
import {chainKey} from '../../shared/terminal.js';
import {THESIS_WINDOWS,type ThesisWindow,type ThesisSummary,type TokenThesis} from '../../shared/theses.js';
import type {ThesisPage} from './thesisSource.js';
import type {CuBudget} from './cuBudget.js';

type Job={chain:Chain;token:string;cursor:string|null;scanStarted:number|null;scanInvalid:boolean;scanCount:number;coverageFrom:number|null;coverageTo:number|null;lastOk:number|null;error:string|null;headNext?:boolean};
export function decodeThesisCursor(cursor:string):[number,string]{
  const value=JSON.parse(Buffer.from(cursor,'base64url').toString());
  if(!Array.isArray(value)||value.length!==2||!Number.isSafeInteger(value[0])||value[0]<0||typeof value[1]!=='string'||!value[1].startsWith('fomoscan:'))throw new Error('Invalid thesis cursor');
  return value as [number,string];
}
const REFRESH=300000,HISTORY=14*86400000;
export class ThesisStore{
  private db:DatabaseSync;
  constructor(file:string){this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS thesis_posts(id TEXT PRIMARY KEY,chain TEXT,token TEXT,time INTEGER,hash TEXT,body TEXT);
    CREATE INDEX IF NOT EXISTS thesis_scope ON thesis_posts(chain,token,time,id);
    CREATE TABLE IF NOT EXISTS thesis_observations(seq INTEGER PRIMARY KEY,observed INTEGER,body TEXT);
    CREATE TABLE IF NOT EXISTS thesis_jobs(key TEXT PRIMARY KEY,requested INTEGER,due INTEGER,body TEXT);`);}
  watch(chain:Chain,token:string,now:number){
    token=chainKey(chain,token);const key=`${chain}:${token}`;
    const job:Job={chain,token,cursor:null,scanStarted:null,scanInvalid:false,scanCount:0,coverageFrom:null,coverageTo:null,lastOk:null,error:null};
    this.db.prepare('INSERT INTO thesis_jobs VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET requested=excluded.requested').run(key,now,now,JSON.stringify(job));
  }
  ingest(items:TokenThesis[]){
    this.db.exec('BEGIN');
    try{for(const item of items){
      const hash=createHash('sha256').update(JSON.stringify({...item,observedAt:0})).digest('hex');
      const id=`${item.source}:${item.id}`;
      const old=this.db.prepare('SELECT hash,chain,token FROM thesis_posts WHERE id=?').get(id) as {hash:string;chain:string;token:string}|undefined;
      if(old&&(old.chain!==item.chain||old.token!==item.token))throw new Error('Thesis ID changed token scope');
      if(old?.hash===hash)continue;
      this.db.prepare('INSERT INTO thesis_observations(observed,body) VALUES(?,?)').run(item.observedAt,JSON.stringify(item));
      this.db.prepare('INSERT OR REPLACE INTO thesis_posts VALUES(?,?,?,?,?,?)').run(id,item.chain,item.token,item.createdAt,hash,JSON.stringify(item));
    }this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  due(now:number):Job|null{
    const row=this.db.prepare('SELECT body FROM thesis_jobs WHERE key IN (SELECT key FROM thesis_jobs WHERE requested>? ORDER BY requested DESC LIMIT 4) AND due<=? ORDER BY due LIMIT 1').get(now-86400000,now) as {body:string}|undefined;
    return row?JSON.parse(row.body):null;
  }
  completePage(job:Job,page:ThesisPage,now:number){
    this.ingest(page.items);
    const started=job.scanStarted??now;
    const oldest=page.oldestTime;
    const invalid=job.scanInvalid||page.skipped>0;
    const finished=!page.hasMore||(oldest!=null&&oldest<=started-HISTORY);
    const count=job.scanCount+page.items.length;
    const next:Job={...job,lastOk:now,error:null,scanInvalid:invalid,scanCount:count,scanStarted:started,cursor:page.nextBefore,headNext:true};
    if(finished){
      // An empty first response can mean the provider is still harvesting; never interpret that as full zero coverage.
      if(count>0&&!invalid){next.coverageFrom=page.hasMore?oldest:0;next.coverageTo=started;}
      next.cursor=null;next.scanStarted=null;next.scanCount=0;next.scanInvalid=false;
    }else if(page.nextBefore===job.cursor)throw new Error('Thesis cursor did not advance');
    this.save(next,now+REFRESH);
  }
  completeHead(job:Job,page:ThesisPage,now:number){
    this.ingest(page.items);
    const contiguous=page.skipped===0&&page.items.length>0&&job.coverageTo!=null&&page.oldestTime!=null&&page.oldestTime<=job.coverageTo;
    this.save({...job,lastOk:now,error:null,headNext:false,coverageTo:contiguous?now:job.coverageTo},now+REFRESH);
  }
  /**
   * Hold a job without losing its backfill position. A budget refusal is not a source failure: the cursor and the
   * scan so far are still valid, and throwing them away would make the next affordable page restart the walk.
   */
  defer(job:Job,reason:string,until:number){this.save({...job,error:reason},until);}
  fail(job:Job,now:number,error:string){this.save({...job,error},now+REFRESH);}
  private save(job:Job,due:number){this.db.prepare('UPDATE thesis_jobs SET due=?,body=? WHERE key=?').run(due,JSON.stringify(job),`${job.chain}:${job.token}`);}
  summary(chain:Chain,token:string,window:ThesisWindow,now:number,connected:boolean,cursor?:string):ThesisSummary{
    token=chainKey(chain,token);
    const row=this.db.prepare('SELECT body FROM thesis_jobs WHERE key=?').get(`${chain}:${token}`) as {body:string}|undefined;
    const job:Job|undefined=row?JSON.parse(row.body):undefined;
    const end=job?.lastOk??now;
    const duration=THESIS_WINDOWS[window],from=end-duration,previousFrom=from-duration;
    const where="chain=? AND token=? AND json_extract(body,'$.deletedAt') IS NULL";
    const count=(a:number,b:number)=>(this.db.prepare(`SELECT COUNT(*) n FROM thesis_posts WHERE ${where} AND time>? AND time<=?`).get(chain,token,a,b) as {n:number}).n;
    const current=count(from,end),previous=count(previousFrom,from);
    const completeCurrent=job?.coverageFrom!=null&&job.coverageTo!=null&&job.coverageTo>=end&&job.coverageFrom<=from;
    const completePrevious=completeCurrent&&job!.coverageFrom!<=previousFrom;
    const authorRows=this.db.prepare(`SELECT COUNT(DISTINCT json_extract(body,'$.authorId')) n,SUM(json_extract(body,'$.authorId') IS NULL) missing FROM thesis_posts WHERE ${where} AND time>? AND time<=?`).get(chain,token,from,end) as {n:number;missing:number|null};
    let after:[number,string]|null=null;
    if(cursor)after=decodeThesisCursor(cursor);
    const rows=this.db.prepare(`SELECT body FROM thesis_posts WHERE ${where} AND time>? AND time<=? ${after?'AND (time<? OR (time=? AND id<?))':''} ORDER BY time DESC,id DESC LIMIT 26`).all(chain,token,from,end,...(after?[after[0],after[0],after[1]]:[])) as {body:string}[];
    const items:TokenThesis[]=rows.slice(0,25).map(r=>JSON.parse(r.body));const last=items.at(-1);
    const known=Boolean(job?.lastOk);
    return {chain,token,window,count:known?current:null,previousCount:completePrevious?previous:null,change:completePrevious?current-previous:null,ratePerHour:completeCurrent?current/(duration/3600000):null,rateChange:completePrevious?(current-previous)/(duration/3600000):null,percentChange:completePrevious&&previous>=5?(current-previous)/previous*100:null,uniqueAuthors:known?authorRows.n:null,unknownAuthors:authorRows.missing??0,observedAt:known?end:null,coverageFrom:job?.coverageFrom??null,completeCurrentWindow:completeCurrent,completePreviousWindow:completePrevious,status:!connected?'disconnected':!known?'warming':job?.error||now-end>2*REFRESH?'stale':!completePrevious?'partial':'ready',error:!connected?'Connect a FomoScan source to populate thesis activity':job?.error??null,source:'fomoscan',deletionCoverage:'unavailable',items,nextCursor:rows.length>25&&last?Buffer.from(JSON.stringify([last.createdAt,`${last.source}:${last.id}`])).toString('base64url'):null};
  }
  close(){this.db.close();}
}
/**
 * Walks one thesis page per due token.
 *
 * Every page is a paid call, and left unpaced this collector measured 12,000 CU/hour against a 250,000 CU monthly
 * grant — the whole month inside a day. With a budget attached, a page is fetched only when the pace has released
 * its price, and otherwise the job is deferred to the exact moment it can be afforded.
 */
export class ThesisCollector{
  private busy=false;private deferred=0;
  constructor(private store:ThesisStore,private load:(chain:Chain,token:string,cursor:string|null)=>Promise<ThesisPage>,private now=Date.now,private budget?:CuBudget){}
  async tick(){
    if(this.busy)return;
    const now=this.now();
    const job=this.store.due(now);
    if(!job)return;
    if(this.budget&&!this.budget.allows(now,'thesisPage')){
      const until=this.budget.nextAllowedAt(now,'thesisPage');
      const state=this.budget.state(now);
      this.deferred++;
      this.store.defer(job,until==null
        ?`Thesis budget for ${state.period} is spent (${state.spent} of ${state.budget} CU); refreshes next month`
        :`Thesis budget paced: ${state.spent} of ${state.budget} CU used this ${state.period}, next page affordable shortly`,
        until??now+REFRESH);
      return;
    }
    this.busy=true;
    try{
      const recent=Boolean(job.cursor&&job.headNext!==false);
      const page=await this.load(job.chain,job.token,recent?null:job.cursor);
      if(recent)this.store.completeHead(job,page,this.now());
      else this.store.completePage(job,page,this.now());
    }catch(e){
      // A served error still cost a page; only a refusal before the meter does not, and /v2/me reconciles either way.
      this.store.fail(job,this.now(),e instanceof Error?e.message:'Thesis source unavailable');
    }finally{this.budget?.record(now,'thesisPage');this.busy=false;}
  }
  state(){return {deferred:this.deferred};}
}
