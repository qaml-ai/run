import { useEffect, useId, useRef, useState } from "react";
import type { AdminTrend } from "../../../src/admin-signals";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const number = (n:number) => new Intl.NumberFormat("en-US").format(n);
const label = (day:string) => new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"short",day:"numeric"}).format(new Date(day+"T12:00:00Z"));

/** This chart always covers the most recent 14 UTC days. The calendar controls above apply to the other reports. */
export function AdminActivityTrend({refresh}:{refresh:number}) {
  const [state,setState]=useState<{refresh:number;data:AdminTrend|null;error:boolean}>({refresh:-1,data:null,error:false});
  useEffect(()=>{
    const abort=new AbortController();
    fetch("/api/activity-trend?days=14",{credentials:"same-origin",cache:"no-store",signal:abort.signal})
      .then(async response=>{if(!response.ok)throw new Error("unavailable");return await response.json() as AdminTrend;})
      .then(data=>{if(!abort.signal.aborted)setState({refresh,data,error:false});})
      .catch(()=>{if(!abort.signal.aborted)setState({refresh,data:null,error:true});});
    return ()=>abort.abort();
  },[refresh]);
  const current=state.refresh===refresh;
  return <section className="panel activity-trend" aria-label="14-day activity trend">
    <div className="panel-heading"><h2>Sign-ups & returning activity</h2><span>Rolling 14 days · UTC days</span></div>
    {!current?<p className="trend-message" role="status">Loading activity trend…</p>:state.error?<p className="trend-message" role="status">The activity trend could not be loaded. Use Refresh to try again.</p>:state.data&&<TrendPlot key={state.data.generated_at} data={state.data}/>}
    <p className="trend-note">Always the latest 14 UTC days, independent of the calendar filter. Returning active accounts were created before that day and received at least one model response; scheduled and channel runs count. Opening the console does not. UTC boundaries differ from the Central Time reports.</p>
  </section>;
}

function TrendPlot({data}:{data:AdminTrend}) {
  const id=useId(),[active,setActive]=useState<number|null>(null);
  const plotRef=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(760);
  useEffect(()=>{
    const element=plotRef.current;
    if(!element||typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(entries=>{
      const measured=entries[0]?.contentRect.width;
      if(measured)setWidth(Math.max(280,measured));
    });
    observer.observe(element);
    return ()=>observer.disconnect();
  },[]);
  if(!data.daily.length)return <p className="trend-message">No daily records are available.</p>;
  const height=250,left=44,right=20,top=20,bottom=38;
  const max=Math.max(4,...data.daily.flatMap(day=>[day.signups,day.returning_active]));
  const step=Math.max(1,Math.ceil(max/4)),ceiling=step*4;
  const x=(i:number)=>left+i*(width-left-right)/Math.max(1,data.daily.length-1);
  const y=(n:number)=>height-bottom-n*(height-top-bottom)/ceiling;
  const path=(key:"signups"|"returning_active")=>data.daily.map((day,i)=>`${i?"L":"M"}${x(i)},${y(day[key])}`).join(" ");
  const chosen=data.daily[active??data.daily.length-1];
  return <>
    <div className="trend-legend"><span><i className="signup-line"/>Sign-ups</span><span><i className="returning-line"/>Returning active accounts</span></div>
    <div className="trend-selection" aria-live="polite"><strong>{label(chosen.date)}{chosen.date===data.incomplete_date?" · Partial day":""}</strong><span>{number(chosen.signups)} sign-ups · {number(chosen.returning_active)} returning active accounts</span></div>
    <div className="trend-scroll" ref={plotRef}><svg viewBox={`0 0 ${width} ${height}`} className="trend-plot" role="group" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>Daily sign-ups and returning active accounts, {data.range.start_date} through {data.range.end_date}, UTC</title>
      <desc id={`${id}-desc`}>Two lines sharing the same count axis. Focus or point to a day for its counts, or expand the data table below. Today's counts are provisional.</desc>
      {[0,1,2,3,4].map(i=><g key={i}><line x1={left} x2={width-right} y1={y(i*step)} y2={y(i*step)} className="trend-grid"/><text x={left-10} y={y(i*step)+4} textAnchor="end" className="trend-axis">{number(i*step)}</text></g>)}
      {data.daily.map((day,i)=>i===0||i===data.daily.length-1||(i%(width<500?5:3)===0&&i<data.daily.length-2)?<text key={day.date} x={x(i)} y={height-10} textAnchor={i===0?"start":i===data.daily.length-1?"end":"middle"} className="trend-axis">{label(day.date)}</text>:null)}
      <path d={path("signups")} className="trend-signups"/><path d={path("returning_active")} className="trend-returning"/>
      {active!==null&&<line x1={x(active)} x2={x(active)} y1={top} y2={height-bottom} className="trend-guide"/>}
      {data.daily.map((day,i)=><g key={day.date}>
        <circle cx={x(i)} cy={y(day.signups)} r={day.date===data.incomplete_date?5:3} className="trend-signup-dot"/>
        <rect x={x(i)-3} y={y(day.returning_active)-3} width={6} height={6} className="trend-returning-dot"/>
        <rect x={x(i)-14} y={top} width={28} height={height-top-bottom} fill="transparent" tabIndex={0} role="button" aria-label={`${day.date}: ${day.signups} sign-ups, ${day.returning_active} returning active accounts${day.date===data.incomplete_date?", partial day":""}`} className="trend-hit" onMouseEnter={()=>setActive(i)} onMouseLeave={()=>setActive(null)} onFocus={()=>setActive(i)} onBlur={()=>setActive(null)} onClick={()=>setActive(i)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setActive(i);}}}/>
      </g>)}
    </svg></div>
    <p className="trend-period">{data.range.start_date} – {data.range.end_date} · UTC{data.incomplete_date?` · ${data.incomplete_date} is still in progress`:""}</p>
    <details className="trend-data"><summary>View daily chart data</summary><Table><TableHeader><TableRow><TableHead>UTC date</TableHead><TableHead>Sign-ups</TableHead><TableHead>Returning active accounts</TableHead></TableRow></TableHeader><TableBody>{data.daily.map(day=><TableRow key={day.date}><TableCell>{day.date}{day.date===data.incomplete_date?" · Partial day":""}</TableCell><TableCell>{number(day.signups)}</TableCell><TableCell>{number(day.returning_active)}</TableCell></TableRow>)}</TableBody></Table></details>
  </>;
}
