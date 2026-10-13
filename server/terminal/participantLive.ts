import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {ParticipantWorker} from './participants.js';
import {monadWalletPortfolio} from '../market/monadWalletPortfolio.js';
import {getTraderService} from '../traders/service.js';
const directory=path.resolve(process.env.TERMINAL_DATA_DIR||'data/terminal');mkdirSync(directory,{recursive:true});
const minutes=Number(process.env.PARTICIPANT_REFRESH_MINUTES||10);
/** Wallet snapshots for the trader panel: on-chain MON + core-asset balances, plus the Nansen / watchlist label when known. */
export const participantWorker=new ParticipantWorker(path.join(directory,'participants.db'),async(_chain,wallet)=>{
  const portfolio=await monadWalletPortfolio(wallet);
  const priced=portfolio.assets.filter(a=>a.valueUsd!=null&&Number.isFinite(a.valueUsd)&&a.valueUsd!>=0);
  const label=getTraderService().handles.get(wallet);
  return {
    balanceUsd:priced.length?priced.reduce((sum,a)=>sum+a.valueUsd!,0):portfolio.assets.length===0&&!portfolio.partial?0:null,
    balanceComplete:false,
    handle:label?.handle??null,
    followers:null,
    protocol:label?'smart':'other',
    error:'Balance covers MON, WMON, USDC and AUSD only; labels are Nansen / watchlist attributions, not ownership verification'
  };
},([5,10,15].includes(minutes)?minutes:10)*60000);
participantWorker.start();
