import {z} from 'zod';
import type {Chain} from '../../shared/wire.js';
import type {BoardKind,BoardSnapshot,TraderIdentity,TraderRanking} from '../../shared/identity.js';
import {chainKey} from '../../shared/terminal.js';

const num=z.number().finite().nullable().optional();
const int=z.number().int().nullable().optional();
const str=z.string().nullable().optional();
const fomoscanEntry=z.object({
  rank:z.number().int().positive(),wallet:z.string().min(1),handle:str,displayName:str,twitter:str,followers:int,
  pnlUsd:num,returnPct:num,volumeUsd:num,trades:int,uniqueTokens:int,winRate:num,avgHoldSeconds:num,
  tokensCreated:int,walletFirstSeenAt:int
});
const fomoscanBoard=z.object({
  window:z.string().min(1),capturedAt:z.number().int().positive(),complete:z.boolean().nullable().optional(),
  coverage:num,walletsRanked:int,count:z.number().int().nonnegative(),entries:z.array(fomoscanEntry).max(100)
});
const pumpEntry=z.object({
  rank:z.number().int().positive(),wallet:z.string().min(1),username:str,isVerified:z.boolean().nullable().optional(),
  pnlUsd:num,pnlPercent:num,realizedPnlUsd:num,unrealizedPnlUsd:num
});
const pumpBoard=z.object({
  period:z.string().min(1),capturedAt:z.number().int().positive().nullable(),
  count:z.number().int().nonnegative(),entries:z.array(pumpEntry).max(100)
});

/** FomoScan returns each wallet in its native encoding; the prefix is the only chain marker on a board row. */
export function chainOfAddress(address:string):Chain{return address.startsWith('0x')?'robinhood':'solana';}
const clean=(value:string|null|undefined)=>{const trimmed=value?.trim();return trimmed?trimmed:null;};

export function normalizeFomoscanTraders(raw:unknown,observedAt:number):BoardSnapshot{
  const board=fomoscanBoard.parse(raw);
  const identities:TraderIdentity[]=[],rankings:TraderRanking[]=[];
  for(const entry of board.entries){
    const chain=chainOfAddress(entry.wallet),wallet=chainKey(chain,entry.wallet);
    const handle=clean(entry.handle);
    // A row with no handle is still a ranked wallet; it is just not an identity, so it never enters the registry.
    if(handle)identities.push({
      chain,wallet,handle,displayName:clean(entry.displayName),twitter:clean(entry.twitter),
      followers:entry.followers??null,userId:null,source:'fomoscan-board',observedAt
    });
    rankings.push({
      board:'fomoscan-traders',window:board.window,rank:entry.rank,chain,wallet,capturedAt:board.capturedAt,
      // This board's `pnlUsd` is realized by definition — it is the daily on-chain sweep, and the schema carries no
      // unrealized leg — so it is recorded as realized rather than left ambiguous alongside the pump board's sum.
      pnlUsd:entry.pnlUsd??null,realizedPnlUsd:entry.pnlUsd??null,unrealizedPnlUsd:null,returnPct:entry.returnPct??null,
      volumeUsd:entry.volumeUsd??null,trades:entry.trades??null,uniqueTokens:entry.uniqueTokens??null,
      winRate:entry.winRate??null,avgHoldSeconds:entry.avgHoldSeconds??null,tokensCreated:entry.tokensCreated??null,
      walletFirstSeenAt:entry.walletFirstSeenAt??null
    });
  }
  return {
    board:'fomoscan-traders',window:board.window,capturedAt:board.capturedAt,count:board.count,
    walletsRanked:board.walletsRanked??null,coverage:board.coverage??null,complete:board.complete??null,
    identities,rankings
  };
}

export function normalizePumpTraders(raw:unknown,observedAt:number):BoardSnapshot{
  const board=pumpBoard.parse(raw);
  const identities:TraderIdentity[]=[],rankings:TraderRanking[]=[];
  for(const entry of board.entries){
    const chain=chainOfAddress(entry.wallet),wallet=chainKey(chain,entry.wallet);
    const handle=clean(entry.username);
    if(handle)identities.push({
      chain,wallet,handle,displayName:null,twitter:null,followers:null,userId:null,source:'pump-board',observedAt
    });
    rankings.push({
      board:'pump-traders',window:board.period,rank:entry.rank,chain,wallet,capturedAt:board.capturedAt??observedAt,
      // pnlUsd here is realized+unrealized. Both legs are carried so a reader is never handed the sum alone.
      pnlUsd:entry.pnlUsd??null,realizedPnlUsd:entry.realizedPnlUsd??null,unrealizedPnlUsd:entry.unrealizedPnlUsd??null,
      returnPct:entry.pnlPercent??null,volumeUsd:null,trades:null,uniqueTokens:null,winRate:null,
      avgHoldSeconds:null,tokensCreated:null,walletFirstSeenAt:null
    });
  }
  return {
    board:'pump-traders',window:board.period,capturedAt:board.capturedAt??observedAt,count:board.count,
    walletsRanked:null,coverage:null,complete:null,identities,rankings
  };
}

const pumpProfile=z.object({
  wallet:z.string().min(1),username:str,xUsername:str,followers:int,isPumpUser:z.boolean().nullable().optional()
});
export function normalizePumpProfile(raw:unknown,observedAt:number):TraderIdentity|null{
  const profile=pumpProfile.parse(raw);
  const handle=clean(profile.username);
  if(!handle)return null;
  const chain=chainOfAddress(profile.wallet);
  return {
    chain,wallet:chainKey(chain,profile.wallet),handle,displayName:null,
    twitter:clean(profile.xUsername),followers:profile.followers??null,userId:null,source:'pump-profile',observedAt
  };
}

/** A FOMO user record: the only read that returns both of a trader's addresses, at 2,500 CU. */
const fomoProfile=z.object({
  id:z.string().min(1),handle:z.string().min(1),name:str,twitter:str,solanaAddress:str,evmAddress:str
});
export function normalizeFomoProfile(raw:unknown,observedAt:number):TraderIdentity[]{
  const profile=fomoProfile.parse(raw);
  const identities:TraderIdentity[]=[];
  for(const address of [profile.solanaAddress,profile.evmAddress]){
    const wallet=clean(address);
    if(!wallet)continue;
    const chain=chainOfAddress(wallet);
    identities.push({
      chain,wallet:chainKey(chain,wallet),handle:profile.handle,displayName:clean(profile.name),
      twitter:clean(profile.twitter),followers:null,userId:profile.id,source:'fomo-profile',observedAt
    });
  }
  return identities;
}

export type BoardRequest={board:BoardKind;window:string};
const PATHS:Record<BoardKind,(window:string)=>string>={
  'fomoscan-traders':(window)=>`/v2/leaderboard/traders-fomoscan?window=${encodeURIComponent(window)}`,
  'pump-traders':(window)=>`/v2/pump/leaderboard/traders?period=${encodeURIComponent(window)}`
};
const NORMALIZERS:Record<BoardKind,(raw:unknown,observedAt:number)=>BoardSnapshot>={
  'fomoscan-traders':normalizeFomoscanTraders,'pump-traders':normalizePumpTraders
};

/** A FomoScan failure that knows whether the call was charged, so a refusal does not silently consume budget. */
export class FomoscanError extends Error{
  constructor(message:string,readonly status:number|null,readonly billed:boolean){super(message);this.name='FomoscanError';}
}

export async function fetchBoard(request:BoardRequest,key:string,now=Date.now()):Promise<BoardSnapshot>{
  let response:Response;
  try{
    response=await fetch(`https://api.fomoscan.sh${PATHS[request.board](request.window)}`,
      {headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
  }catch(e){throw new FomoscanError(e instanceof Error?e.message:'FomoScan unreachable',null,false);}
  // A 402 is refused before the meter and a 401/403 never reaches it; anything the provider served is charged.
  if(response.status===402)throw new FomoscanError('FomoScan units exhausted for this billing period',402,false);
  if(response.status===401||response.status===403)throw new FomoscanError('FomoScan credentials or scope unavailable',response.status,false);
  if(!response.ok)throw new FomoscanError(`FomoScan returned ${response.status}`,response.status,true);
  return NORMALIZERS[request.board](await response.json(),now);
}

const meSchema=z.object({
  usage:z.object({period:z.string().min(1),unitsUsed:z.number().int().nonnegative(),unitsRemaining:z.number().int().nullable()})
});
/**
 * `GET /v2/me` costs 0 CU and reports usage for the whole key, including consumers this process cannot see. It is the
 * only way the local meter learns the truth, so it is worth calling often and never worth skipping to save units.
 */
export async function fetchAccountUsage(key:string){
  const response=await fetch('https://api.fomoscan.sh/v2/me',
    {headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new FomoscanError(`FomoScan returned ${response.status} for the account`,response.status,false);
  return meSchema.parse(await response.json()).usage;
}
