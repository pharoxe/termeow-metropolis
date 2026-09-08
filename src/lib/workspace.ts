import type { InstrumentRef } from './address';
import { isValidInstrument } from './instrument';

export type WorkspaceLayout = 'single' | 'columns' | 'rows' | 'grid';
export type ChartTileState = { id: string; instrument: InstrumentRef; interval: string };
export type WorkspaceState = { version: 1; tiles: ChartTileState[]; activeId: string; layout: WorkspaceLayout };
export const WORKSPACE_KEY = 'termeow-workspace-v1';
export const TILE_INTERVALS = ['5S','15S','1M','5M','15M','1H','4H','1D'];
export function initialWorkspace(instrument: InstrumentRef): WorkspaceState {
  return {version:1,tiles:[{id:'chart-1',instrument,interval:'15M'}],activeId:'chart-1',layout:'single'};
}
export function restoreWorkspace(value: unknown, fallback: InstrumentRef): WorkspaceState {
  const initial=initialWorkspace(fallback);
  if(!value || typeof value!=='object')return initial;
  const v=value as Partial<WorkspaceState>;
  if(v.version!==1 || !Array.isArray(v.tiles))return initial;
  const seen=new Set<string>();
  const tiles=v.tiles.filter(t=>t && typeof t.id==='string' && t.id.length<100 && !seen.has(t.id) && seen.add(t.id) && t.instrument && ['solana','robinhood'].includes(t.instrument.chain) && typeof t.instrument.address==='string' && isValidInstrument(t.instrument)).slice(0,4).map(t=>({...t,interval:TILE_INTERVALS.includes(t.interval)?t.interval:'15M'}));
  if(!tiles.length)return initial;
  const layout=['single','columns','rows','grid'].includes(v.layout??'')?v.layout!:'single';
  return {version:1,tiles,activeId:tiles.some(t=>t.id===v.activeId)?v.activeId!:tiles[0].id,layout};
}
export function addTile(state: WorkspaceState, instrument: InstrumentRef, id: string): WorkspaceState {
  if(state.tiles.length>=4 || !isValidInstrument(instrument) || state.tiles.some(t=>t.id===id))return state;
  const interval=state.tiles.find(t=>t.id===state.activeId)?.interval??'15M';
  return {...state,tiles:[...state.tiles,{id,instrument,interval}],activeId:id,layout:state.tiles.length>=2?'grid':'columns'};
}
export function closeTile(state: WorkspaceState, id: string): WorkspaceState {
  if(state.tiles.length===1)return state;
  const tiles=state.tiles.filter(t=>t.id!==id);
  return {...state,tiles,activeId:state.activeId===id?tiles[0].id:state.activeId,layout:tiles.length===1?'single':state.layout};
}
