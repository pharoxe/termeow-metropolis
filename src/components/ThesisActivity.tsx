import {useEffect,useState} from 'react';
import type {InstrumentRef} from '../lib/address';
import {instrumentKey} from '../lib/instrument';
import {useResource} from '../lib/resource';
import type {ThesisSummary,ThesisWindow} from '../../shared/theses';

export function ThesisActivity({instrument,compact=false}:{instrument:InstrumentRef;compact?:boolean}){
  const [window,setWindow]=useState<ThesisWindow>('24h');
  const [cursor,setCursor]=useState<string|null>(null);
  const [expanded,setExpanded]=useState(false);
  useEffect(()=>{setCursor(null);setExpanded(false);},[instrument.chain,instrument.address]);
  const key=`theses:${instrumentKey(instrument)}:${window}:${cursor??''}`;
  const query=useResource<ThesisSummary>(key,async()=>{
    const response=await fetch(`/api/theses/${instrument.chain}/${instrument.address}/summary?window=${window}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Thesis activity unavailable');return response.json();
  },30000);
  const data=query.data;
  const change=data?.change;
  const number=data?.count==null?'—':`${data.completeCurrentWindow?'':'≥'}${data.count}`;
  const stats=<><b>{number} THESES</b><span>{change==null?'Comparison pending':`${change>0?'+':''}${change} vs prior ${window.toUpperCase()}`}</span><span>{data?.ratePerHour==null?'Rate —':`${data.ratePerHour.toFixed(1)}/hour`}</span><span>{data?.uniqueAuthors??'—'} authors{data?.unknownAuthors?` · ${data.unknownAuthors} unattributed`:''}</span></>;
  return <section className={`thesis-activity ${compact?'thesis-compact':''}`} aria-label="FOMO thesis activity">
    <div className="thesis-heading"><strong>FOMO / THESIS ACTIVITY</strong>{!compact&&<select aria-label="Thesis comparison window" value={window} onChange={e=>{setWindow(e.target.value as ThesisWindow);setCursor(null);}}>{(['1h','6h','24h','7d'] as const).map(w=><option key={w} value={w}>{w.toUpperCase()}</option>)}</select>}<small>{query.error?'UNAVAILABLE':data?.status.toUpperCase()??'LOADING'}</small></div>
    <button className="thesis-metrics" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{stats}</button>
    {(!compact||expanded)&&<><p className="thesis-note">{query.error||data?.error||'Authored engagement observed in the source. Edits are deduplicated; deletion coverage is unavailable.'} {data?.observedAt?`As of ${new Date(data.observedAt).toLocaleString()}.`:''}</p>
    {data?.rateChange!=null&&<p className="thesis-note">Rate change {data.rateChange>0?'+':''}{data.rateChange.toFixed(2)} theses/hour{data.percentChange!=null?` · ${data.percentChange>0?'+':''}${data.percentChange.toFixed(1)}%`:''} · equal-length prior window</p>}
    {expanded&&<div className="thesis-records">{data?.items.map(item=><article key={item.id}><div><b>{item.authorHandle?`@${item.authorHandle}`:'Unknown author'}</b><time>{new Date(item.createdAt).toLocaleString()}</time></div><p>{item.text}</p>{item.url&&<a href={item.url} target="_blank" rel="noreferrer">Source author profile ↗</a>}</article>)}{!data?.items.length&&<p>No thesis records captured for this window.</p>}<div>{cursor&&<button onClick={()=>setCursor(null)}>LATEST</button>}{data?.nextCursor&&<button onClick={()=>setCursor(data.nextCursor)}>OLDER THESES</button>}</div></div>}</>}
  </section>;
}
