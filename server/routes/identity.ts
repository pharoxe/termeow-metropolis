import {Router} from 'express';
import path from 'node:path';
import {z} from 'zod';
import {BoardCollector,IdentityRegistry} from '../terminal/identityRegistry.js';
import {boardFetcher} from '../terminal/identityRegistry.js';
import {accountStatus,boardBudget,fomoscanDirectory,fomoscanKey} from '../terminal/fomoscanAccount.js';
import {tradeArchive} from '../terminal/live.js';
import {config} from '../config.js';
import type {BoardKind} from '../../shared/identity.js';

/**
 * The cheap half of FomoScan. A board call names up to 100 wallets for 250 CU; resolving one unknown address costs
 * 50,000. So the registry is filled from boards and profile reads, and never by sweeping addresses — at plan rates a
 * sweep of the wallets this server has already seen would cost several hundred million units.
 */
const registry=new IdentityRegistry(path.join(fomoscanDirectory,'identity.db'));
const DAY=86400000;
// Preserve the useful short-window board without spending the remaining monthly grant on redundant snapshots.
const REQUESTS=[
  {board:'fomoscan-traders' as const,window:'24h',intervalMs:2*DAY},
  {board:'fomoscan-traders' as const,window:'all',intervalMs:7*DAY},
  {board:'pump-traders' as const,window:'weekly',intervalMs:3*DAY}
];
const collector=new BoardCollector(registry,boardBudget,REQUESTS,
  fomoscanKey?boardFetcher(fomoscanKey):async()=>{throw new Error('FomoScan key not configured');},
  config.fomoscan.boardIntervalMs);
if(fomoscanKey){
  void collector.tick().catch(()=>{});
  const timer=setInterval(()=>void collector.tick().catch(()=>{}),60000);
  timer.unref();
}

const boardKinds=['fomoscan-traders','pump-traders'] as const;
const chainSchema=z.enum(['solana','robinhood']);
export const identityRouter=Router();

identityRouter.get('/coverage',(_req,res,next)=>{
  try{
    const now=Date.now();
    res.json({
      ...registry.coverage({
        observed:{solana:tradeArchive.wallets('solana',now),robinhood:tradeArchive.wallets('robinhood',now)},
        budget:boardBudget.state(now),refusedForBudget:collector.state().refused,lastError:collector.state().lastError
      }),
      account:accountStatus(now)
    });
  }catch(e){next(e);}
});

identityRouter.get('/board/:board/:window',(req,res,next)=>{
  try{
    const params=z.object({board:z.enum(boardKinds),window:z.string().min(1).max(16)}).parse(req.params);
    const limit=z.coerce.number().int().min(1).max(100).default(100).parse(req.query.limit??100);
    const chain=chainSchema.optional().parse(req.query.chain);
    res.json({
      board:params.board as BoardKind,window:params.window,
      entries:registry.ranked(params.board,params.window,limit,chain)
    });
  }catch(e){next(e);}
});

identityRouter.get('/wallet/:chain/:address',(req,res,next)=>{
  try{
    const params=z.object({chain:chainSchema,address:z.string().min(1).max(120)}).parse(req.params);
    // Registry only. A miss is "not named from a board we have read", never "this wallet has no owner" — naming it
    // would cost 50,000 CU, so that stays a deliberate act rather than something a page view can trigger.
    res.json({...params,identity:registry.lookup(params.chain,params.address),resolution:'registry-only'});
  }catch(e){next(e);}
});

identityRouter.get('/handle/:handle',(req,res,next)=>{
  try{
    const handle=z.string().min(1).max(64).parse(req.params.handle);
    res.json({handle,addresses:registry.byHandle(handle)});
  }catch(e){next(e);}
});
