import {instrumentKey} from "../lib/instrument";
import {terminalStyle} from "../lib/themeTokens";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicConfig } from '../types';
import type { InstrumentRef } from '../lib/address';
import { InstrumentTile } from '../components/InstrumentTile';
import { addTile, closeTile, initialWorkspace, restoreWorkspace, WORKSPACE_KEY, type WorkspaceLayout, type WorkspaceState } from '../lib/workspace';
import '../components/workspace.css';
import '../components/terminal-theme.css';
import {createCrosshairBus} from '../lib/crosshairBus';
import {useTheme} from '../components/ThemeToggle';

export function DeskPage({config}:{config:PublicConfig}){
  const [theme,setTheme]=useTheme();
  const [names,setNames]=useState<Record<string,string>>({});
  const reportName=useCallback((key:string,name:string)=>setNames(old=>old[key]===name?old:{...old,[key]:name}),[]);
  const [panels,setPanels]=useState(()=>{try{const p=JSON.parse(localStorage.getItem('terminal-panels')??'{}');return {left:Math.max(170,Math.min(360,Number(p.left)||240)),right:Math.max(230,Math.min(420,Number(p.right)||280)),hideLeft:p.hideLeft===true,hideRight:p.hideRight===true};}catch{return {left:240,right:280,hideLeft:false,hideRight:false};}});
  useEffect(()=>{try{localStorage.setItem('terminal-panels',JSON.stringify(panels));}catch{}},[panels]);
  const [crosshairBus]=useState(createCrosshairBus);
  const [workspace,setWorkspace]=useState<WorkspaceState>(()=>{const fallback={chain:'solana' as const,address:config.ansemMint};try{return restoreWorkspace(JSON.parse(localStorage.getItem(WORKSPACE_KEY)??'null'),fallback);}catch{return initialWorkspace(fallback);}});
  const [header,setHeader]=useState<HTMLDivElement|null>(null);
  const [discovery,setDiscovery]=useState<HTMLDivElement|null>(null);
  const [rail,setRail]=useState<HTMLDivElement|null>(null);
  const [context,setContext]=useState<HTMLDivElement|null>(null);
  const [section,setSection]=useState('Trade');
  const [linkInterval,setLinkInterval]=useState(false),[linkReplay,setLinkReplay]=useState(false),[linkCrosshair,setLinkCrosshair]=useState(false);
  const [replay,setReplay]=useState<{source:string;time:number|null;revision:number}>();
  const [replacement,setReplacement]=useState<InstrumentRef|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{try{localStorage.setItem(WORKSPACE_KEY,JSON.stringify(workspace));}catch{}},[workspace]);
  useEffect(()=>{if(replacement)dialog.current?.showModal();else dialog.current?.close();},[replacement]);
  const changeInstrument=useCallback((id:string,instrument:InstrumentRef)=>setWorkspace(w=>({...w,tiles:w.tiles.map(t=>t.id===id?{...t,instrument}:t)})),[]);
  const changeInterval=useCallback((id:string,interval:string)=>setWorkspace(w=>({...w,tiles:w.tiles.map(t=>linkInterval||t.id===id?{...t,interval}:t)})),[linkInterval]);
  const openNew=useCallback((instrument:InstrumentRef)=>{if(workspace.tiles.length>=4){setReplacement(instrument);return;}setWorkspace(w=>addTile(w,instrument,crypto.randomUUID()));},[workspace.tiles.length]);
  const active=workspace.tiles.find(t=>t.id===workspace.activeId)!;
  const reportReplay=useCallback((source:string,time:number|null)=>{if(linkReplay)setReplay(r=>({source,time,revision:(r?.revision??0)+1}));},[linkReplay]);
  const reportCrosshair=useCallback((source:string,time:number|null)=>{if(linkCrosshair)crosshairBus.publish(source,time);},[linkCrosshair,crosshairBus]);
  useEffect(()=>{
    const handle=(e:KeyboardEvent)=>{if(!(e.altKey&&/^[1-4]$/.test(e.key)))return;const tile=workspace.tiles[Number(e.key)-1];if(tile){e.preventDefault();setWorkspace(w=>({...w,activeId:tile.id}));}};
    window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);
  },[workspace.tiles]);
  return <main className="onchain-desk terminal-workspace" style={{...terminalStyle(theme),...{"--discovery-width":`${panels.left}px`,"--context-width":`${panels.right}px`} as React.CSSProperties}} data-hide-left={panels.hideLeft} data-hide-right={panels.hideRight} data-layout={workspace.layout} data-section={section}>
    <div ref={setHeader} className="workspace-header"/>
    <div className="workspace-controls" aria-label="Chart workspace controls">
      <strong>WORKSPACE</strong>
      <select aria-label="Chart layout" value={workspace.layout} onChange={e=>setWorkspace(w=>({...w,layout:e.target.value as WorkspaceLayout}))}>
        <option value="single">Single / maximized</option><option value="columns">Side by side</option><option value="rows">Stacked</option><option value="grid">Four chart grid</option>
      </select>
      <button onClick={()=>openNew(active.instrument)}>＋ ADD CHART</button>
      <span className="workspace-link-label">LINK</span>
      <label><input type="checkbox" checked={linkInterval} onChange={e=>setLinkInterval(e.target.checked)}/>Timeframe</label>
      <label><input type="checkbox" checked={linkCrosshair} onChange={e=>setLinkCrosshair(e.target.checked)}/>Crosshair</label>
      <label><input type="checkbox" checked={linkReplay} onChange={e=>setLinkReplay(e.target.checked)}/>Replay</label>
      <details className="panel-options"><summary>PANELS</summary><div>
        <label><input type="checkbox" checked={!panels.hideLeft} onChange={e=>{const hideLeft=!e.currentTarget.checked;setPanels(p=>({...p,hideLeft}));}}/>Discovery</label>
        <label>Discovery width <input aria-label="Discovery panel width" type="range" min="170" max="360" value={panels.left} onChange={e=>{const left=Number(e.currentTarget.value);setPanels(p=>({...p,left}));}}/></label>
        <label><input type="checkbox" checked={!panels.hideRight} onChange={e=>{const hideRight=!e.currentTarget.checked;setPanels(p=>({...p,hideRight}));}}/>Trader context</label>
        <label>Context width <input aria-label="Trader context panel width" type="range" min="230" max="420" value={panels.right} onChange={e=>{const right=Number(e.currentTarget.value);setPanels(p=>({...p,right}));}}/></label>
      </div></details>
      <small>{workspace.tiles.length}/4 charts · Alt + 1–4 to focus</small>
    </div>
    <div className="workspace-tabs" aria-label="Open charts">{workspace.tiles.map((tile,index)=><button key={tile.id} aria-pressed={tile.id===workspace.activeId} onClick={()=>setWorkspace(w=>({...w,activeId:tile.id}))}>{index+1} · {tile.instrument.chain==='solana'?'SOL':'RHC'} · {names[instrumentKey(tile.instrument)]??'TOKEN'} · {tile.instrument.address.slice(0,6)}… · {tile.interval}</button>)}</div>
    <div className="workspace-body">
      <div ref={setDiscovery} className="workspace-discovery"/>
      <div className="workspace-center"><div className="workspace-charts">
        {header&&discovery&&context&&rail&&workspace.tiles.map((tile,index)=><article key={tile.id} className={`workspace-chart ${tile.id===workspace.activeId?'active':''}`} hidden={workspace.layout==='single'&&tile.id!==workspace.activeId} onPointerDownCapture={()=>{if(tile.id!==workspace.activeId)setWorkspace(w=>({...w,activeId:tile.id}));}} onFocusCapture={()=>{if(tile.id!==workspace.activeId)setWorkspace(w=>({...w,activeId:tile.id}));}} aria-label={`Chart ${index+1}`}>
          <div className="workspace-tile-actions"><button aria-label={`Focus chart ${index+1}`} onClick={()=>setWorkspace(w=>({...w,activeId:tile.id}))}>CHART {index+1} · {tile.instrument.chain.toUpperCase()}</button>
            <button title="Move chart earlier" disabled={index===0} onClick={()=>setWorkspace(w=>{const tiles=[...w.tiles];[tiles[index-1],tiles[index]]=[tiles[index],tiles[index-1]];return {...w,tiles};})}>←</button>
            <button title="Duplicate chart" onClick={()=>openNew(tile.instrument)}>DUPLICATE</button>
            <button title="Maximize chart" onClick={()=>setWorkspace(w=>({...w,activeId:tile.id,layout:w.layout==='single'?(w.tiles.length>2?'grid':'columns'):'single'}))}>{workspace.layout==='single'?'RESTORE':'MAX'}</button>
            <button aria-label={`Close chart ${index+1}`} disabled={workspace.tiles.length===1} onClick={()=>setWorkspace(w=>closeTile(w,tile.id))}>×</button>
          </div>
          <InstrumentTile onName={reportName} config={config} tile={tile} isActive={tile.id===workspace.activeId} slots={{header,discovery,context,rail}} onInstrument={changeInstrument} onInterval={changeInterval} onNew={openNew} onSection={setSection} linkedReplay={linkReplay?replay:undefined} onReplay={reportReplay} crosshairBus={crosshairBus} onCrosshair={reportCrosshair} theme={theme} setTheme={setTheme}/>
        </article>)}
      </div>
      <div ref={setContext} className="workspace-context"/>
      </div>
      <div ref={setRail} className="workspace-sidebar"/>
    </div>
    <dialog ref={dialog} className="workspace-replace" onCancel={()=>setReplacement(null)}><h3>Choose a chart to replace</h3><p>Four charts are already open.</p>{workspace.tiles.map((tile,index)=><button key={tile.id} onClick={()=>{if(replacement)changeInstrument(tile.id,replacement);setWorkspace(w=>({...w,activeId:tile.id}));setReplacement(null);}}>Chart {index+1} · {tile.instrument.address.slice(0,8)}…</button>)}<button onClick={()=>setReplacement(null)}>Cancel</button></dialog>
  </main>;
}
