import {describe,it,expect,vi} from 'vitest';
import type {FlowPrint} from '../../shared/wire.js';
import {mapKnownAttribution} from './attribution.js';
const print:FlowPrint={chain:'monad',pair:'pool',tx:'tx',time:1,usd:10,side:'buy',source:'own',trader:{address:'0xABC',kind:'other',handle:null,followers:null}};
describe('early attribution',()=>{
  it('reuses established classification and social mapping',()=>{
    const out=mapKnownAttribution(print,{peekKind:()=> 'smart',handles:{get:()=>({handle:'known',followers:20000})}});
    expect(out.trader).toMatchObject({address:'0xabc',kind:'smart',handle:'known',followers:20000});
  });
  it('leaves prints without a trader untouched',()=>{
    const peekKind=vi.fn();const input={...print,trader:undefined};
    expect(mapKnownAttribution(input,{peekKind,handles:{get:()=>null}})).toBe(input);expect(peekKind).not.toHaveBeenCalled();
  });
});
