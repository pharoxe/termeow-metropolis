import { fetchDexScreenerList, dexScreenerListPartials, DEXSCREENER_DISCOVERY_SOURCE } from "./dexscreenerLists.js";
import type { DiscoverResponse, DiscoverView, DiscoverWindow } from '../../shared/wire.js';
import { fetchGeckoList, geckoListSource, normalizeGeckoListRow } from './geckoLists.js';
import { mergeDiscover, rankRows, type DiscoverPartial } from './merge.js';
/** Shared discovery envelope and ranking; wallet identity coverage remains explicitly unknown. */
export async function discoverSolana(view:DiscoverView, window:DiscoverWindow):Promise<DiscoverResponse> {
  const kind=view==='new'?'new':'trending';
  const results=await Promise.allSettled([fetchGeckoList('solana',kind),fetchDexScreenerList('solana')]);
  const now=Date.now(),source=geckoListSource(kind);
  const partials:DiscoverPartial[]=[];
  const sources=results.map((result,index)=>{
    const name=index===0?source:DEXSCREENER_DISCOVERY_SOURCE;
    if(result.status==='rejected')return {name,lastOkAt:null,lastError:String(result.reason),stale:true};
    return {name,lastOkAt:result.value.observedAt,lastError:result.value.error??null,stale:result.value.stale};
  });
  const gecko=results[0],dex=results[1];
  if(gecko.status==='fulfilled')partials.push(...gecko.value.value.map((row,index)=>normalizeGeckoListRow(row,index,kind,window,'solana',now,gecko.value.observedAt,gecko.value.stale)).filter((row):row is DiscoverPartial=>row!==null));
  if(dex.status==='fulfilled')partials.push(...dexScreenerListPartials('solana',dex.value.value,window,now,dex.value.observedAt,dex.value.stale));
  const error=view==='holders'?'Verified social-to-wallet coverage is unavailable on Solana; no smart-holder ranking can be established.':sources.filter(s=>s.lastError).map(s=>`${s.name}: ${s.lastError}`).join('; ');
  return {chain:'solana',view,window,rows:view==='holders'?[]:rankRows(view,mergeDiscover('solana',partials,[DEXSCREENER_DISCOVERY_SOURCE,source]),source).slice(0,60),observedAt:now,sources,coverage:null,stale:sources.some(s=>s.stale),...(error?{error}:{})};
}
