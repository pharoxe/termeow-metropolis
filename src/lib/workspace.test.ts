import {describe,it,expect,vi} from 'vitest';
import {initialWorkspace,addTile,closeTile,restoreWorkspace} from './workspace';
import {resource} from './resource';
const instrument={chain:'monad' as const,address:'0x3bd359c1119da7da1d913d1c4d2b7c461115433a'};
describe('chart workspace',()=>{
  it('preserves intervals, caps charts and keeps the final chart',()=>{
    let state=initialWorkspace(instrument);state.tiles[0].interval='1H';
    for(let i=2;i<=5;i++)state=addTile(state,instrument,`chart-${i}`);
    expect(state.tiles).toHaveLength(4);expect(state.tiles.every(t=>t.interval==='1H')).toBe(true);
    expect(restoreWorkspace(JSON.parse(JSON.stringify(state)),instrument)).toEqual(state);
    for(const tile of [...state.tiles])state=closeTile(state,tile.id);
    expect(state.tiles).toHaveLength(1);expect(state.activeId).toBe(state.tiles[0].id);
  });
  it('rejects invalid saved tokens and duplicate IDs',()=>{
    const state=initialWorkspace(instrument);
    const restored=restoreWorkspace({...state,activeId:'missing',tiles:[...state.tiles,...state.tiles,{id:'bad',instrument:{chain:'monad',address:'bad'}}]},instrument);
    expect(restored.tiles).toHaveLength(1);expect(restored.activeId).toBe('chart-1');
  });
  it('shares requests and stops polling only after the final subscriber leaves',async()=>{
    vi.useFakeTimers();
    try{
      const load=vi.fn().mockResolvedValue(42);
      const a=resource('test-shared',load,1000),b=resource('test-shared',load,1000);
      const offA=a.subscribe(()=>{}),offB=b.subscribe(()=>{});
      await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(1);
      offA();await vi.advanceTimersByTimeAsync(1000);expect(load).toHaveBeenCalledTimes(2);
      expect(b.getSnapshot().data).toBe(42);
      offB();await vi.advanceTimersByTimeAsync(5000);expect(load).toHaveBeenCalledTimes(2);
    }finally{vi.useRealTimers();}
  });
});
