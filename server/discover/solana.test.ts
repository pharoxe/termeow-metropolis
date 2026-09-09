import {describe,it,expect,vi} from 'vitest';
import {mergeDiscover,emptyFigures} from './merge.js';
import {normalizeDexScreenerPair,discoveryAddresses} from './dexscreenerLists.js';
import {buildDiscoverResponse} from '../routes/discover.js';
const token='So11111111111111111111111111111111111111112';
describe('shared Solana discovery',()=>{
  it('preserves case through normalization and merge',()=>{
    const partial=normalizeDexScreenerPair(token,{pairAddress:token},'24h',1,1,false,'solana');
    expect(mergeDiscover('solana',[partial],[])[0]).toMatchObject({token,pool:token});
  });
  it('does not merge differently cased Solana mints',()=>{
    const base={...emptyFigures(),source:'test',lastOkAt:1,stale:false,rank:null,symbol:null,name:null};
    expect(mergeDiscover('solana',[{...base,token},{...base,token:token.toLowerCase()}],[])).toHaveLength(2);
  });
  it('routes Solana through its own adapter',async()=>{
    const solana=vi.fn(async()=>({chain:'solana' as const,view:'trending' as const,window:'24h' as const,rows:[],observedAt:1,sources:[],coverage:null}));
    const robinhood=vi.fn();await buildDiscoverResponse({chain:'solana',view:'trending',window:'24h'},{solana,robinhood,now:()=>1});
    expect(solana).toHaveBeenCalledWith('trending','24h');expect(robinhood).not.toHaveBeenCalled();
  });
});
