import {z} from 'zod';
import type {Chain} from '../../shared/wire.js';
import type {TokenThesis} from '../../shared/theses.js';
import {chainKey} from '../../shared/terminal.js';
const itemSchema=z.object({id:z.string().min(1),authorHandle:z.string().nullable(),authorId:z.string().nullable().optional(),thesis:z.string().nullable(),fomoCreatedAt:z.number().int().nonnegative().nullable(),tokenAddress:z.string().nullable().optional(),tokenNetwork:z.string().nullable().optional()});
const pageSchema=z.object({tokenAddress:z.string(),tokenNetwork:z.string().nullable(),hasMore:z.boolean(),nextBefore:z.string().nullable(),items:z.array(itemSchema).max(25)});
export type ThesisPage={items:TokenThesis[];hasMore:boolean;nextBefore:string|null;oldestTime:number|null;skipped:number};
function networkMatches(chain:Chain,network:string|null|undefined){return chain==='solana'?network==='sol'||network==='solana':network==='robinhood';}
export function normalizeThesisPage(raw:unknown,chain:Chain,token:string,now:number):ThesisPage{
  const page=pageSchema.parse(raw);
  if(chainKey(chain,page.tokenAddress)!==chainKey(chain,token))throw new Error('Thesis token mismatch');
  if(page.items.length&&!networkMatches(chain,page.tokenNetwork))throw new Error('Thesis network is unknown or differs from the requested chain');
  if(page.hasMore&&!page.nextBefore)throw new Error('Missing thesis backfill cursor');
  let skipped=0;
  const items:TokenThesis[]=[];
  for(const item of page.items){
    if(item.tokenAddress&&chainKey(chain,item.tokenAddress)!==chainKey(chain,token))throw new Error('Thesis item token mismatch');
    if(item.tokenNetwork&&!networkMatches(chain,item.tokenNetwork))throw new Error('Thesis item network mismatch');
    if(item.fomoCreatedAt==null||item.fomoCreatedAt>now||!item.thesis?.trim()){skipped++;continue;}
    items.push({source:'fomoscan',id:item.id,chain,token:chainKey(chain,token),authorId:item.authorId??null,authorHandle:item.authorHandle,text:item.thesis.trim(),createdAt:item.fomoCreatedAt,observedAt:now,deletedAt:null,url:item.authorHandle?`https://fomo.family/profile/${encodeURIComponent(item.authorHandle)}`:null});
  }
  const times=page.items.map(i=>i.fomoCreatedAt).filter((t):t is number=>t!=null&&t<=now);
  return {items,hasMore:page.hasMore,nextBefore:page.nextBefore,oldestTime:times.length?Math.min(...times):null,skipped};
}
export async function fetchThesisPage(chain:Chain,token:string,before:string|null,key:string):Promise<ThesisPage>{
  const url=new URL(`https://api.fomoscan.sh/v2/thesis/token/${encodeURIComponent(token)}`);
  if(before)url.searchParams.set('before',before);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(response.status===401||response.status===403?'Thesis source credentials or access unavailable':`Thesis source returned ${response.status}`);
  return normalizeThesisPage(await response.json(),chain,token,Date.now());
}
