import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {ParticipantWorker} from './participants.js';
import {walletPortfolio} from '../market/walletPortfolio.js';
import {getTraderService} from '../traders/service.js';
import {config} from '../config.js';
import {fetchJson} from '../lib/http.js';
import {isFomoCode} from '../traders/identity.js';
const directory=path.resolve(process.env.TERMINAL_DATA_DIR||'data/terminal');mkdirSync(directory,{recursive:true});
const minutes=Number(process.env.PARTICIPANT_REFRESH_MINUTES||10);
export const participantWorker=new ParticipantWorker(path.join(directory,'participants.db'),async(chain,wallet)=>{
  if(chain==='solana'){
    const portfolio=await walletPortfolio(wallet);
    const priced=portfolio.assets.filter(a=>a.valueUsd!=null&&Number.isFinite(a.valueUsd)&&a.valueUsd!>=0);
    return {balanceUsd:priced.length?priced.reduce((sum,a)=>sum+a.valueUsd!,0):portfolio.assets.length===0&&!portfolio.partial?0:null,balanceComplete:!portfolio.partial&&!portfolio.valuationUnavailable,handle:null,followers:null,protocol:'unknown',error:portfolio.partial||portfolio.valuationUnavailable?'Partial holdings or unpriced assets; not a complete wallet valuation':null};
  }
  const body=await fetchJson<{result?:string;error?:unknown}>(config.robinhood.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getCode',params:[wallet,'latest']})});
  if(body.error||typeof body.result!=='string')throw new Error('Protocol check failed');
  const social=getTraderService().handles.get(wallet);
  return {balanceUsd:null,balanceComplete:false,handle:social?.handle??null,followers:social?.followers??null,protocol:isFomoCode(body.result)?'fomo':'other',error:'Full Robinhood wallet valuation source unavailable; social mapping is not ownership verification'};
},([5,10,15].includes(minutes)?minutes:10)*60000);
participantWorker.start();
