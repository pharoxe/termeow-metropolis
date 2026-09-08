import {describe,it,expect} from 'vitest';
import {CuBudget,FOMOSCAN_CU} from './cuBudget';
const JAN=Date.UTC(2026,0,1),DAY=86400000,MID=Date.UTC(2026,0,16,12);
const budget=(over:Partial<{grant:number;share:number;burst:number}>={})=>new CuBudget(':memory:',{grant:250000,share:0.5,burst:1000,...over});

describe('FomoScan unit budget',()=>{
  it('releases a burst immediately and the rest evenly across the month',()=>{
    const b=budget();
    try{
      // A fresh month has spent nothing, so only the burst is available on the first instant.
      expect(b.state(JAN).allowance).toBe(1000);
      expect(b.allows(JAN,'thesisPage')).toBe(true);
      b.record(JAN,'thesisPage');b.record(JAN,'thesisPage');b.record(JAN,'thesisPage');b.record(JAN,'thesisPage');
      expect(b.state(JAN).spent).toBe(1000);
      expect(b.allows(JAN,'thesisPage')).toBe(false);
      // Half the month elapsed releases half of the 125,000 share on top of the burst.
      expect(b.state(MID).allowance).toBe(1000+125000*(MID-JAN)/(Date.UTC(2026,1,1)-JAN));
      expect(b.allows(MID,'thesisPage')).toBe(true);
    }finally{b.close();}
  });

  it('refuses a call the account cannot pay for even when the local pace allows it',()=>{
    const b=budget({burst:200000});
    try{
      b.observeAccount({period:'2026-01',unitsUsed:210750,unitsRemaining:39250},JAN);
      // Pace has room, but a wallet resolution costs more than the account holds.
      expect(b.allows(JAN,'thesisPage')).toBe(true);
      expect(b.allows(JAN,'userByWallet')).toBe(false);
      expect(b.state(JAN).source).toBe('account');
      expect(b.state(JAN).accountRemaining).toBe(39250);
    }finally{b.close();}
  });

  it('an unmetered key is never refused for balance',()=>{
    const b=budget({burst:200000});
    try{
      b.observeAccount({period:'2026-01',unitsUsed:900000,unitsRemaining:null},JAN);
      expect(b.allows(JAN,'userByWallet')).toBe(true);
    }finally{b.close();}
  });

  it('records what a call actually cost, not what it reserved',()=>{
    const b=budget();
    try{
      b.record(JAN,'userByWallet',FOMOSCAN_CU.miss);
      expect(b.state(JAN).spent).toBe(250);
      expect(b.state(JAN).calls).toBe(1);
    }finally{b.close();}
  });

  it('starts each UTC month from zero and keeps the prior month readable',()=>{
    const b=budget();
    try{
      b.record(JAN+DAY,'thesisPage');
      expect(b.state(JAN+DAY).spent).toBe(250);
      const feb=Date.UTC(2026,1,2);
      expect(b.state(feb).spent).toBe(0);
      expect(b.state(feb).period).toBe('2026-02');
      expect(b.state(JAN+DAY).spent).toBe(250);
    }finally{b.close();}
  });

  it('will not re-spend a grant that was already consumed before the meter existed',()=>{
    const b=budget({burst:0});
    try{
      // A meter installed on the 16th with an empty ledger would otherwise read half the month as unspent.
      expect(b.allowance(MID)).toBeGreaterThan(60000);
      b.observeAccount({period:'2026-01',unitsUsed:210750,unitsRemaining:39250},MID);
      // Anchored: only this consumer's share of what the account actually still holds, released over what is left.
      expect(b.allowance(MID)).toBe(0);
      expect(b.allows(MID,'thesisPage')).toBe(false);
      const end=Date.UTC(2026,1,1),half=MID+(end-MID)/2;
      expect(b.allowance(half)).toBeCloseTo(0.5*39250*0.5,6);
      // The burst can bring spending forward but never above the share of the balance that was really there.
      const greedy=new CuBudget(':memory:',{grant:250000,share:0.5,burst:50000});
      greedy.observeAccount({period:'2026-01',unitsUsed:210750,unitsRemaining:39250},MID);
      expect(greedy.allowance(MID)).toBe(0.5*39250);
      greedy.record(MID,'thesisPage',0.5*39250);
      expect(greedy.allows(MID,'thesisPage')).toBe(false);
      expect(greedy.nextAllowedAt(MID,'thesisPage')).toBeNull();
      greedy.close();
      // A later reading that has fallen further must not push the anchor back up.
      b.observeAccount({period:'2026-01',unitsUsed:230000,unitsRemaining:20000},half);
      expect(b.state(half).baselineRemaining).toBe(39250);
      expect(b.allowance(half)).toBeCloseTo(0.5*39250*0.5,6);
    }finally{b.close();}
  });

  it('says exactly when the pace will cover the next call',()=>{
    const b=budget({burst:0});
    try{
      // 125,000 CU released across January, so 250 CU is covered once 1/500th of the month has passed.
      const month=Date.UTC(2026,1,1)-JAN;
      expect(b.nextAllowedAt(JAN,'thesisPage')).toBe(Math.ceil(JAN+250*month/125000));
      expect(b.allows(b.nextAllowedAt(JAN,'thesisPage')!,'thesisPage')).toBe(true);
      // An expensive call the share can still cover just waits proportionally longer.
      expect(b.nextAllowedAt(JAN,'socketMinute')).toBe(Math.ceil(JAN+20000*month/125000));
      // A call the whole month's share cannot cover is never a matter of waiting.
      expect(new CuBudget(':memory:',{grant:1000,share:0.1,burst:0}).nextAllowedAt(JAN,'userByWallet')).toBeNull();
    }finally{b.close();}
  });

  it('separates a share not yet released from a share already spent',()=>{
    const b=budget({burst:0});
    try{
      // Nothing is released on the first instant of the month, but the whole share is still unspent.
      const opening=b.state(JAN);
      expect(opening.budget).toBe(125000);
      expect(opening.remaining).toBe(125000);
      expect(opening.allowance).toBe(0);
      expect(b.allows(JAN,'board')).toBe(false);
      // Spending the released half of the month leaves the other half, and refuses again until more is released.
      b.record(MID,'board',62500);
      const midpoint=b.state(MID);
      expect(midpoint.spent).toBe(62500);
      expect(midpoint.remaining).toBe(62500);
      expect(b.allows(MID,'board')).toBe(false);
    }finally{b.close();}
  });
});
