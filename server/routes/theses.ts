import {Router} from 'express';
import path from 'node:path';
import {z} from 'zod';
import {ThesisStore,ThesisCollector,decodeThesisCursor} from '../terminal/theses.js';
import {fetchThesisPage} from '../terminal/thesisSource.js';
import {fomoscanDirectory,fomoscanKey,startAccountReconciliation,thesisBudget} from '../terminal/fomoscanAccount.js';
import {flowParamsSchema} from './flow.js';
const store=new ThesisStore(path.join(fomoscanDirectory,'theses.db'));
const key=fomoscanKey;
const collector=new ThesisCollector(store,(chain,token,cursor)=>fetchThesisPage(chain,token,cursor,key!),Date.now,thesisBudget);
// A bounded page per active token, and only when the month's paced share can pay for it; no paid calls without a key.
if(key){
  const timer=setInterval(()=>void collector.tick().catch(()=>{}),15000);
  timer.unref();
  startAccountReconciliation();
}
export const thesesRouter=Router();
thesesRouter.get('/:chain/:address/summary',(req,res,next)=>{
  try{
    const {chain,address}=flowParamsSchema.parse(req.params);
    const query=z.object({window:z.enum(['1h','6h','24h','7d']).default('24h'),cursor:z.string().max(1000).optional()}).parse(req.query);
    if(query.cursor){try{decodeThesisCursor(query.cursor);}catch{res.status(400).json({error:'Invalid thesis cursor'});return;}}
    store.watch(chain,address,Date.now());
    res.json(store.summary(chain,address,query.window,Date.now(),Boolean(key),query.cursor));
  }catch(e){next(e);}
});
