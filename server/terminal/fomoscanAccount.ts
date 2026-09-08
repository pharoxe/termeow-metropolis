import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {config} from '../config.js';
import {CuBudget} from './cuBudget.js';
import {fetchAccountUsage} from './fomoscanBoards.js';

/**
 * One shared FomoScan account across every consumer in this process.
 *
 * The units are granted per key, not per feature, so the meters have to live together: two ledgers that each believed
 * they held the whole grant would together spend twice it. `GET /v2/me` costs nothing and reports the key's real usage
 * including calls made outside this process, so it is polled on a slow timer and folded into both meters.
 */
export const fomoscanDirectory=path.resolve(process.env.TERMINAL_DATA_DIR||'data/terminal');
mkdirSync(fomoscanDirectory,{recursive:true});
const ledgerFile=path.join(fomoscanDirectory,'fomoscan.db');
const shared={grant:config.fomoscan.monthlyUnits,burst:config.fomoscan.burstUnits};

export const thesisBudget=new CuBudget(ledgerFile,{...shared,share:config.fomoscan.thesisShare,label:'theses'});
export const boardBudget=new CuBudget(ledgerFile,{...shared,share:config.fomoscan.boardShare,label:'boards'});
export const fomoscanKey=config.fomoscan.apiKey;

let accountError:string|null=null;
export function accountStatus(now=Date.now()){
  const state=thesisBudget.state(now);
  return {
    connected:Boolean(fomoscanKey),grant:config.fomoscan.monthlyUnits,period:state.period,
    accountUsed:state.accountUsed,accountRemaining:state.accountRemaining,checkedAt:state.checkedAt,
    consumers:thesisBudget.ledger(now),error:accountError
  };
}

/** Reconcile both meters against the account. Never charged, so failure only costs freshness. */
export async function reconcileAccount(now=Date.now()){
  if(!fomoscanKey)return false;
  try{
    const usage=await fetchAccountUsage(fomoscanKey);
    thesisBudget.observeAccount(usage,now);
    boardBudget.observeAccount(usage,now);
    accountError=null;
    return true;
  }catch(e){accountError=e instanceof Error?e.message:'FomoScan account unreadable';return false;}
}

export function startAccountReconciliation(intervalMs=300000){
  if(!fomoscanKey)return ()=>{};
  void reconcileAccount();
  const timer=setInterval(()=>void reconcileAccount(),intervalMs);
  timer.unref();
  return ()=>clearInterval(timer);
}
