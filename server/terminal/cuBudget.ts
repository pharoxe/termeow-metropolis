import {DatabaseSync} from 'node:sqlite';

/**
 * Published FomoScan prices, read from https://api.fomoscan.sh/openapi.json on 2026-09-08. Identity resolution by
 * address is 200x the price of every other read, so a caller must reserve at the price of the call it is about to
 * make rather than assume a flat rate. A 404 costs `miss` on every priced endpoint.
 */
export const FOMOSCAN_CU={miss:250,thesisPage:250,board:250,pumpUser:250,userByHandle:2500,userById:2500,traderPnl:2500,userByWallet:50000,socketMinute:20000} as const;
export type FomoscanCall=keyof typeof FOMOSCAN_CU;

/** What `GET /v2/me` reports; it costs 0 CU, so the meter can be corrected against the account rather than assumed. */
export type AccountUsage={period:string;unitsUsed:number;unitsRemaining:number|null};
export type CuBudgetState={
  label:string;period:string;budget:number;share:number;spent:number;remaining:number;allowance:number;calls:number;
  source:'account'|'local';accountUsed:number|null;accountRemaining:number|null;checkedAt:number|null;
  baselineAt:number|null;baselineRemaining:number|null;
};

const period=(now:number)=>{const d=new Date(now);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;};
const bounds=(now:number)=>{const d=new Date(now),y=d.getUTCFullYear(),m=d.getUTCMonth();return {start:Date.UTC(y,m,1),end:Date.UTC(y,m+1,1)};};

/**
 * A paced spending meter for one FomoScan consumer.
 *
 * The plan's grant is monthly and does not roll over, so an unpaced poller drains it in hours: the thesis collector
 * measured 12,000 CU/hour against a 250,000 CU month. `share` is this consumer's slice of the grant and it is released
 * linearly across the UTC month, plus a `burst` so a newly opened token can still backfill at once. Spend is recorded
 * per month and never migrates between periods.
 */
export class CuBudget{
  private db:DatabaseSync;
  private account:{usage:AccountUsage;checkedAt:number}|null=null;
  readonly grant:number;readonly share:number;readonly burst:number;readonly label:string;
  constructor(file:string,options:{grant:number;share:number;burst:number;label?:string}){
    this.grant=Math.max(0,options.grant);
    this.share=Math.min(1,Math.max(0,options.share));
    this.burst=Math.max(0,options.burst);
    this.label=options.label??'default';
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS fomoscan_spend(period TEXT,label TEXT,units INTEGER NOT NULL,calls INTEGER NOT NULL,
        baselineAt INTEGER,baselineRemaining INTEGER,PRIMARY KEY(period,label));`);
    // Older ledgers predate the balance anchor; adding the columns is cheaper than a rebuild and keeps prior spend.
    const columns=new Set((this.db.prepare('PRAGMA table_info(fomoscan_spend)').all() as {name:string}[]).map((c)=>c.name));
    if(!columns.has('baselineAt'))this.db.exec('ALTER TABLE fomoscan_spend ADD COLUMN baselineAt INTEGER');
    if(!columns.has('baselineRemaining'))this.db.exec('ALTER TABLE fomoscan_spend ADD COLUMN baselineRemaining INTEGER');
  }
  /** This consumer's slice of the grant for a whole month. */
  get budget(){return Math.floor(this.grant*this.share);}
  private row(now:number){
    return this.db.prepare('SELECT units,calls,baselineAt,baselineRemaining FROM fomoscan_spend WHERE period=? AND label=?')
      .get(period(now),this.label) as {units:number;calls:number;baselineAt:number|null;baselineRemaining:number|null}|undefined;
  }
  /** Every consumer's spend this month, so a status view can show the split without a second ledger. */
  ledger(now:number){
    return this.db.prepare('SELECT label,units,calls FROM fomoscan_spend WHERE period=? ORDER BY label')
      .all(period(now)) as {label:string;units:number;calls:number}[];
  }
  /**
   * Units released so far: the burst, plus whichever of two paces is tighter.
   *
   * The first paces this consumer's share of the monthly grant across the whole month. On its own it is wrong whenever
   * the ledger is younger than the spending — a meter installed mid-month reads its own zero as "nothing spent" and
   * releases weeks of allowance at once. The second paces the share of the balance the account actually had when this
   * meter first saw the period, across the time left in it, so a grant already 88% consumed elsewhere cannot be spent
   * again here. Taking the lower of the two means both hold.
   */
  allowance(now:number){
    const {start,end}=bounds(now);
    const grantPace=this.budget*Math.min(1,Math.max(0,(now-start)/(end-start)));
    const row=this.row(now);
    if(row?.baselineAt==null||row.baselineRemaining==null)return this.burst+grantPace;
    const span=Math.max(1,end-row.baselineAt);
    const balancePace=this.share*row.baselineRemaining*Math.min(1,Math.max(0,(now-row.baselineAt)/span));
    // The anchor is a ceiling as well as a rate. Without it the burst is unbounded spending by another name: two
    // consumers each holding a 5,000 CU burst would take 10,000 out of a 26,000 balance in their first hour.
    return Math.min(this.entitlement(now),this.burst+Math.min(grantPace,balancePace));
  }
  /** The most this consumer may spend this period: its share of the balance the account held when anchored. */
  entitlement(now:number){
    const row=this.row(now);
    return row?.baselineRemaining==null?Infinity:this.share*row.baselineRemaining;
  }
  /**
   * Whether this call may be made now. Two independent gates: our own pace, and — when `GET /v2/me` has been observed —
   * the account's real balance, because a call the account cannot pay for is refused with a 402 regardless of pace.
   */
  allows(now:number,call:FomoscanCall){
    const cost=FOMOSCAN_CU[call];
    const remaining=this.account?.usage.unitsRemaining;
    if(this.account&&remaining!=null&&remaining<cost)return false;
    return (this.row(now)?.units??0)+cost<=this.allowance(now);
  }
  /**
   * When the pace will have released enough for this call, so a caller can sleep exactly that long instead of
   * retrying into a refusal. Returns null when the month's whole share cannot cover it, or when the account balance
   * is the thing standing in the way — neither is fixed by waiting for the pace.
   */
  nextAllowedAt(now:number,call:FomoscanCall):number|null{
    const cost=FOMOSCAN_CU[call];
    if(this.allows(now,call))return now;
    const remaining=this.account?.usage.unitsRemaining;
    if(this.account&&remaining!=null&&remaining<cost)return null;
    const {start,end}=bounds(now);
    const row=this.row(now);
    const total=(row?.units??0)+cost;
    // Past the period's ceiling, no amount of waiting helps; only next month's grant does.
    if(total>this.entitlement(now))return null;
    const needed=total-this.burst;
    if(needed<=0)return now;
    if(!this.budget||needed>this.budget)return null;
    let at=start+needed*(end-start)/this.budget;
    if(row?.baselineAt!=null&&row.baselineRemaining!=null)
      at=Math.max(at,row.baselineAt+needed*Math.max(1,end-row.baselineAt)/(this.share*row.baselineRemaining));
    return Math.min(end,Math.ceil(at));
  }
  /** Record a completed call. `units` defaults to the call's list price; pass `FOMOSCAN_CU.miss` for a 404. */
  record(now:number,call:FomoscanCall,units:number=FOMOSCAN_CU[call]){
    this.db.prepare(`INSERT INTO fomoscan_spend VALUES(?,?,?,1,NULL,NULL)
      ON CONFLICT(period,label) DO UPDATE SET units=units+excluded.units,calls=calls+1`)
      .run(period(now),this.label,Math.max(0,Math.round(units)));
    if(this.account?.usage.unitsRemaining!=null)
      this.account={...this.account,usage:{...this.account.usage,unitsUsed:this.account.usage.unitsUsed+units,unitsRemaining:Math.max(0,this.account.usage.unitsRemaining-units)}};
  }
  /**
   * Fold in a free `GET /v2/me` reading. It covers every consumer of the key, which our own ledger cannot see, and the
   * first reading of a period anchors the balance pace. The anchor is written once so later readings — which fall as
   * this meter spends — cannot ratchet the allowance back up.
   */
  observeAccount(usage:AccountUsage,now:number){
    this.account={usage,checkedAt:now};
    if(usage.unitsRemaining==null)return;
    const row=this.row(now);
    if(row?.baselineAt!=null)return;
    if(row)this.db.prepare('UPDATE fomoscan_spend SET baselineAt=?,baselineRemaining=? WHERE period=? AND label=?')
      .run(now,usage.unitsRemaining,period(now),this.label);
    else this.db.prepare('INSERT INTO fomoscan_spend VALUES(?,?,0,0,?,?)')
      .run(period(now),this.label,now,usage.unitsRemaining);
  }
  state(now:number):CuBudgetState{
    const row=this.row(now),spent=row?.units??0;
    return {
      label:this.label,period:period(now),budget:this.budget,share:this.share,spent,remaining:Math.max(0,this.budget-spent),
      allowance:this.allowance(now),calls:row?.calls??0,
      source:this.account?'account':'local',
      accountUsed:this.account?.usage.unitsUsed??null,
      accountRemaining:this.account?.usage.unitsRemaining??null,
      checkedAt:this.account?.checkedAt??null,
      baselineAt:row?.baselineAt??null,baselineRemaining:row?.baselineRemaining??null
    };
  }
  close(){this.db.close();}
}
