import {DatabaseSync} from 'node:sqlite';
import type {Chain} from '../../shared/wire.js';
import type {BoardKind,BoardSnapshot,IdentityCoverage,IdentitySource,RankedTrader,TraderIdentity,TraderRanking} from '../../shared/identity.js';
import {chainKey} from '../../shared/terminal.js';
import type {CuBudget,CuBudgetState} from './cuBudget.js';
import {FomoscanError,fetchBoard,type BoardRequest} from './fomoscanBoards.js';

/**
 * How much a source is trusted when two of them name the same wallet. A profile read resolved that one address; a
 * board row only listed it, and a board's handle can lag a rename. Equal ranks refresh in place so a repeated board
 * sweep keeps follower counts and timestamps current.
 */
const AUTHORITY:Record<IdentitySource,number>={'pump-board':0,'fomoscan-board':1,'pump-profile':2,'fomo-profile':3};
const SOURCES=Object.keys(AUTHORITY) as IdentitySource[];
const COLUMNS='chain,wallet,handle,displayName,twitter,followers,userId,source,observedAt';

export class IdentityRegistry{
  private db:DatabaseSync;
  constructor(file:string){
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS identities(chain TEXT,wallet TEXT,handle TEXT,displayName TEXT,twitter TEXT,
        followers INTEGER,userId TEXT,source TEXT,observedAt INTEGER,firstSeenAt INTEGER,PRIMARY KEY(chain,wallet));
      CREATE INDEX IF NOT EXISTS identity_handle ON identities(handle);
      CREATE TABLE IF NOT EXISTS rankings(board TEXT,window TEXT,chain TEXT,wallet TEXT,rank INTEGER,capturedAt INTEGER,
        body TEXT,PRIMARY KEY(board,window,chain,wallet));
      CREATE TABLE IF NOT EXISTS boards(board TEXT,window TEXT,capturedAt INTEGER,count INTEGER,walletsRanked INTEGER,
        coverage REAL,observedAt INTEGER,PRIMARY KEY(board,window));`);
  }
  /** Keeps the better-sourced record. Returns true when this call changed what the registry holds. */
  upsert(identity:TraderIdentity):boolean{
    const wallet=chainKey(identity.chain,identity.wallet);
    const existing=this.db.prepare('SELECT source,firstSeenAt FROM identities WHERE chain=? AND wallet=?')
      .get(identity.chain,wallet) as {source:IdentitySource;firstSeenAt:number}|undefined;
    if(existing&&AUTHORITY[identity.source]<AUTHORITY[existing.source])return false;
    this.db.prepare(`INSERT INTO identities VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(chain,wallet) DO UPDATE SET handle=excluded.handle,displayName=excluded.displayName,
        twitter=excluded.twitter,followers=excluded.followers,userId=excluded.userId,source=excluded.source,
        observedAt=excluded.observedAt`)
      .run(identity.chain,wallet,identity.handle,identity.displayName,identity.twitter,identity.followers,
        identity.userId,identity.source,identity.observedAt,existing?.firstSeenAt??identity.observedAt);
    return true;
  }
  record(snapshot:BoardSnapshot,observedAt:number){
    this.db.exec('BEGIN');
    try{
      for(const identity of snapshot.identities)this.upsert(identity);
      // A stored ranking is one snapshot, never a pile of them. The rows are keyed on the wallet, so INSERT OR REPLACE
      // alone leaves the previous read's wallets behind: the 24h/7d boards are a rolling window over 316,007 wallets
      // and turn over most of their top 100 between daily reads, which would interleave two capture instants at the
      // same ranks and hand ranked() a table that is half a day old with every rank printed twice.
      this.db.prepare('DELETE FROM rankings WHERE board=? AND window=?').run(snapshot.board,snapshot.window);
      for(const ranking of snapshot.rankings)
        this.db.prepare('INSERT OR REPLACE INTO rankings VALUES(?,?,?,?,?,?,?)')
          .run(ranking.board,ranking.window,ranking.chain,ranking.wallet,ranking.rank,ranking.capturedAt,JSON.stringify(ranking));
      this.db.prepare('INSERT OR REPLACE INTO boards VALUES(?,?,?,?,?,?,?)')
        .run(snapshot.board,snapshot.window,snapshot.capturedAt,snapshot.count,snapshot.walletsRanked,snapshot.coverage,observedAt);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  lookup(chain:Chain,wallet:string):TraderIdentity|null{
    const row=this.db.prepare(`SELECT ${COLUMNS} FROM identities WHERE chain=? AND wallet=?`)
      .get(chain,chainKey(chain,wallet)) as TraderIdentity|undefined;
    return row??null;
  }
  /** Every address the registry holds for one handle — the cross-chain link, when a profile read supplied both. */
  byHandle(handle:string):TraderIdentity[]{
    return this.db.prepare(`SELECT ${COLUMNS} FROM identities WHERE handle=? COLLATE NOCASE ORDER BY chain`)
      .all(handle) as TraderIdentity[];
  }
  /**
   * A board's rows with the name the registry already holds for each wallet. The boards deposit those identities
   * themselves, so the join is a local read costing nothing — without it the tab renders an address where the same
   * database row two tables over says "Dedrater". A null identity means no board we have read named that wallet.
   */
  ranked(board:BoardKind,window:string,limit=100):RankedTrader[]{
    const rows=this.db.prepare(`SELECT r.body, ${COLUMNS.split(',').map((c)=>`i.${c} AS i_${c}`).join(',')}
      FROM rankings r LEFT JOIN identities i ON i.chain=r.chain AND i.wallet=r.wallet
      WHERE r.board=? AND r.window=? ORDER BY r.rank LIMIT ?`)
      .all(board,window,limit) as Array<{body:string}&Record<string,unknown>>;
    return rows.map((row)=>{
      const ranking=JSON.parse(row.body) as TraderRanking;
      const identity=row.i_wallet==null?null:Object.fromEntries(
        COLUMNS.split(',').map((column)=>[column,row[`i_${column}`]])) as unknown as TraderIdentity;
      return {...ranking,identity};
    });
  }
  /** When a board was last read, so a collector can pace itself without a second source of truth. */
  boardObservedAt(board:BoardKind,window:string):number|null{
    const row=this.db.prepare('SELECT observedAt FROM boards WHERE board=? AND window=?')
      .get(board,window) as {observedAt:number}|undefined;
    return row?.observedAt??null;
  }
  private counts(){
    const byChain:Partial<Record<Chain,number>>={},bySource={} as Record<IdentitySource,number>;
    for(const source of SOURCES)bySource[source]=0;
    const rows=this.db.prepare('SELECT chain,source,COUNT(*) n FROM identities GROUP BY chain,source')
      .all() as {chain:Chain;source:IdentitySource;n:number}[];
    let identities=0;
    for(const row of rows){
      byChain[row.chain]=(byChain[row.chain]??0)+row.n;
      bySource[row.source]=(bySource[row.source]??0)+row.n;
      identities+=row.n;
    }
    return {identities,byChain,bySource};
  }
  /** How many of the wallets this server has actually seen trade the registry can put a name to. */
  coverage(options:{observed?:Partial<Record<Chain,Iterable<string>>>|null;budget?:CuBudgetState|null;refusedForBudget?:number;lastError?:string|null}={}):IdentityCoverage{
    const {identities,byChain,bySource}=this.counts();
    let observedWallets:IdentityCoverage['observedWallets']=null;
    if(options.observed){
      observedWallets={} as NonNullable<IdentityCoverage['observedWallets']>;
      for(const [chain,wallets] of Object.entries(options.observed) as [Chain,Iterable<string>][]){
        let seen=0,named=0;
        for(const wallet of wallets){seen++;if(this.lookup(chain,wallet))named++;}
        observedWallets[chain]={seen,named};
      }
    }
    const budget=options.budget;
    return {
      identities,byChain,bySource,observedWallets,
      boards:this.db.prepare('SELECT board,window,capturedAt,count,walletsRanked,coverage,observedAt FROM boards ORDER BY board,window')
        .all() as IdentityCoverage['boards'],
      budget:budget?{period:budget.period,spent:budget.spent,budget:budget.budget,allowance:Math.floor(budget.allowance),
        accountRemaining:budget.accountRemaining,checkedAt:budget.checkedAt}:null,
      refusedForBudget:options.refusedForBudget??0,
      lastError:options.lastError??null
    };
  }
  close(){this.db.close();}
}

/**
 * Refreshes the 250 CU boards on a paced budget.
 *
 * These are the only reads that name wallets in bulk: one call returns up to 100 traders with handle and performance
 * for the price of a single thesis page, against 50,000 CU to resolve one unknown address. The collector takes at most
 * one board per tick, skips boards read within `intervalMs`, and stops when the budget refuses rather than retrying.
 */
export class BoardCollector{
  private index=0;private refused=0;private error:string|null=null;
  constructor(
    private registry:IdentityRegistry,
    private budget:CuBudget,
    private requests:readonly BoardRequest[],
    private fetcher:(request:BoardRequest)=>Promise<BoardSnapshot>,
    private intervalMs=86400000
  ){}
  async tick(now=Date.now()):Promise<boolean>{
    if(!this.requests.length)return false;
    const request=this.requests[this.index++%this.requests.length];
    const last=this.registry.boardObservedAt(request.board,request.window);
    if(last!=null&&now-last<this.intervalMs)return false;
    if(!this.budget.allows(now,'board')){this.refused++;return false;}
    try{
      const snapshot=await this.fetcher(request);
      this.budget.record(now,'board');
      this.registry.record(snapshot,now);
      this.error=null;
      return true;
    }catch(e){
      // Only charge for a call the provider actually served. A 402 or 401 never reaches the meter, and a transport
      // failure may not have either; `GET /v2/me` costs nothing and reconciles whatever this under-counts.
      if(e instanceof FomoscanError&&e.billed)this.budget.record(now,'board');
      this.error=e instanceof Error?e.message:'FomoScan board request failed';
      return false;
    }
  }
  state(){return {refused:this.refused,lastError:this.error};}
}

export function boardFetcher(key:string){return (request:BoardRequest)=>fetchBoard(request,key);}
