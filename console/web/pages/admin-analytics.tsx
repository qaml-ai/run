"use client";
import { useEffect, useState } from "react";
import { Activity, Users, CreditCard, Play, CalendarDays, RefreshCw, PlugZap, AlertCircle, MousePointerClick } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog as Sheet, DialogContent as SheetContent, DialogHeader as SheetHeader, DialogTitle as SheetTitle, DialogDescription as SheetDescription } from "@/components/ui/dialog";
import { PageHeader } from "@/components/common";
import type { AdminSignals } from "../../../src/admin-signals";
import "./admin-analytics.css";
import { presetRange, rangeError, TIME_ZONE } from "@/lib/admin-range";
import type { ReportRange, ReportRequest, JourneysReport, JourneyReport, JourneyRow } from "@/lib/admin-report-types";
type SignalsReport = AdminSignals & {kind:"signals"};
type ReportResult = SignalsReport | JourneysReport | JourneyReport;
const count = (n: number) => new Intl.NumberFormat("en-US").format(n);
const money = (n: number) => new Intl.NumberFormat("en-US", {style:"currency",currency:"USD"}).format(n/100);
const date = (iso: string|null, time = false) => iso ? new Intl.DateTimeFormat("en-US", {timeZone:TIME_ZONE,month:"short",day:"numeric",year:"numeric",...(time?{hour:"numeric",minute:"2-digit"}: {})}).format(new Date(iso)) : "Not recorded";
const calendarLabel = (range: ReportRange) => { const label = (value:string) => new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"short",day:"numeric",year:"numeric"}).format(new Date(value+"T12:00:00Z")); return range.start_date===range.end_date?label(range.start_date):`${label(range.start_date)} – ${label(range.end_date)}`; };
const accountName = (row: JourneyRow) => row.display_name || row.email || `Account ${row.account_ref.slice(0,8)}…${row.account_ref.slice(-6)}`;
const eventName = (name: string) => name.replace(/^run_/, "").replace(/^sales_/, "Sales · ").replaceAll("_", " ").replace(/^./, s=>s.toUpperCase());
const errorCopy: Record<string,{title:string;body:string}> = {
  report_not_configured:{title:"Waiting for the tracking connection",body:"Journey tracking is not connected yet. Product signals are available separately from Run’s database."},
  local_preview:{title:"Local preview",body:"Production data is not loaded in this preview. The live dashboard will use the secure reporting connection."},
  sign_in_required:{title:"Your session has ended",body:"Reload this page to sign in through Cloudflare Access with an approved work account."},
  admin_required:{title:"Admin access required",body:"This dashboard is restricted to the three approved CamelAI admins."},
  report_too_large:{title:"Choose a shorter date range",body:"This range contains more activity than one report can safely load. Narrow the dates to view complete counts."},
  range_too_long:{title:"Choose a shorter date range",body:"Reports support up to 366 calendar days at a time."},
  account_deleted:{title:"This account has been erased",body:"Its journey is no longer available."},
  account_not_found:{title:"Journey unavailable",body:"This account is no longer available in reporting."},
};
function useReport<T extends ReportResult>(request: ReportRequest|null, refresh: number) {
  const key = request ? JSON.stringify(request) : "";
  const [state,setState]=useState<{key:string;refresh:number;data:T|null;error:string|null}>({key:"",refresh:-1,data:null,error:null});
  useEffect(()=>{
    if (!key) return;
    const abort = new AbortController();
    const parsed = JSON.parse(key) as ReportRequest;
    const signalRequest = parsed.kind === "signals";
    const url = signalRequest ? `/api/product-signals?${new URLSearchParams({start_date:parsed.start_date,end_date:parsed.end_date,time_zone:parsed.time_zone})}` : "/api/report";
    fetch(url,{method:signalRequest?"GET":"POST",...(signalRequest?{}:{headers:{"content-type":"application/json"},body:key}),credentials:"same-origin",cache:"no-store",signal:abort.signal})
      .then(async r=>{if(r.status===401)throw new Error("sign_in_required");if(r.status===403)throw new Error("admin_required");const body=await r.json();if(!r.ok)throw new Error(body.error||"report_unavailable");return (signalRequest?{...body,kind:"signals"}:body) as T;})
      .then(data=>{if(!abort.signal.aborted)setState({key,refresh,data,error:null});})
      .catch(e=>{if(!abort.signal.aborted)setState({key,refresh,data:null,error:e instanceof Error?e.message:"report_unavailable"});});
    return ()=>abort.abort();
  },[key,refresh]);
  const current = state.key===key && state.refresh===refresh;
  return {data:current?state.data:null,error:current?state.error:null,loading:!!key&&!current};
}
function Notice({error,loading}: {error:string|null;loading?:boolean}) {
  const copy=errorCopy[error||""]||{title:"Reports are temporarily unavailable",body:"The last request could not be completed. Try refreshing in a moment."};
  return <div className="empty-state" role="status">{loading?<RefreshCw size={28} className="animate-spin"/>:error==="report_not_configured"||error==="local_preview"?<PlugZap size={30}/>:<AlertCircle size={30}/>}<h3>{loading?"Loading your report…":copy.title}</h3><p>{loading?"Checking the selected calendar dates.":copy.body}</p>{error==="sign_in_required"&&<a className="text-link" href="/">Sign in</a>}</div>;
}
function Coverage({report}: {report: JourneysReport|JourneyReport}) {
  return <p className="coverage">{report.coverage.first_event_at ? <>Tracking records available from {date(report.coverage.first_event_at)}. Latest event: {date(report.coverage.last_event_at,true)}.</> : "Connected, but no events have been collected yet."} <span>Report updated {date(report.generated_at,true)}.</span></p>;
}
export function AdminAnalytics() {
  const [range,setRange]=useState<ReportRange>(()=>presetRange("today"));
  const [draft,setDraft]=useState(range),[preset,setPreset]=useState("today"),[filterError,setFilterError]=useState<string|null>(null);
  const [tab,setTab]=useState("signals"),[refresh,setRefresh]=useState(0);
  const [cursors,setCursors]=useState<string[]>([]),[selected,setSelected]=useState<string|null>(null);
  const report=useReport<SignalsReport|JourneysReport>({schema_version:1,...range,kind:tab==="signals"?"signals":"journeys",...(tab==="journeys"&&cursors.length?{cursor:cursors.at(-1)}:{})},refresh);
  const applyRange=(next:ReportRange)=>{ const error=rangeError(next);setFilterError(error);if(error)return false;setRange(next);setDraft(next);setCursors([]);setSelected(null);return true; };
  const signals=report.data?.kind==="signals"?report.data:null;
  const journeys=report.data?.kind==="journeys"?report.data:null;
  const ready=report.data?.kind==="signals" || !!journeys?.coverage.first_event_at;
  const status=report.loading?"Loading report":report.data?(signals?"Run database":report.data.kind!=="signals"&&report.data.coverage.first_event_at?"Tracking connected":"Connected · no events yet"):(report.error==="report_not_configured")?"Tracking not connected":"Report unavailable";
  return <div className="admin-analytics">
    <section aria-label="Run analytics">
      <PageHeader title="Admin" description="Product signals and user journeys" actions={<span className="connection" aria-live="polite">{status}</span>}/>
      <form className="date-bar" onSubmit={e=>{e.preventDefault();applyRange(draft);}} aria-label="Date range">
        <div className="date-title"><CalendarDays size={18}/><strong>Date range</strong></div>
        <label className="preset-label" htmlFor="calendar-preset"><span>Calendar preset</span><select id="calendar-preset" aria-label="Calendar preset" value={preset} onChange={e=>{setPreset(e.target.value);if(e.target.value!=="custom")applyRange(presetRange(e.target.value));}}>{[["today","Today"],["yesterday","Yesterday"],["week","This week"],["month","This month"],["last-month","Last month"],["custom","Custom dates"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <label htmlFor="date-from">From<Input id="date-from" aria-label="From date" required type="date" value={draft.start_date} onChange={e=>{setDraft({...draft,start_date:e.target.value});setPreset("custom");}}/></label>
        <label htmlFor="date-through">Through<Input id="date-through" aria-label="Through date" required type="date" value={draft.end_date} onChange={e=>{setDraft({...draft,end_date:e.target.value});setPreset("custom");}}/></label>
        <Button type="submit">Apply</Button><span className="timezone">Central Time<small>America/Chicago</small></span>
        {filterError&&<p className="filter-error" role="alert">{filterError}</p>}
      </form>
      <div className="view-controls"><p>{calendarLabel(range)} <span>· Both dates included</span></p><Button variant="outline" size="sm" onClick={()=>setRefresh(n=>n+1)} disabled={report.loading}><RefreshCw size={14}/>Refresh</Button></div>
      <Tabs value={tab} onValueChange={value=>{setTab(value);setCursors([]);}}><TabsList className="dashboard-tabs"><TabsTrigger value="signals"><Activity size={17}/>Product signals</TabsTrigger><TabsTrigger value="journeys"><Users size={17}/>User journeys</TabsTrigger></TabsList>
        <TabsContent value="signals">
          <div className="metric-grid">{[{label:"Sign-ups",icon:Users,value:signals?.summary.signups,detail:"New self-serve accounts"},{label:"Activated accounts",icon:Play,value:signals?.summary.activations,detail:!signals?"First successful execution":signals.summary.activations===null?"First-run tracking unavailable":signals.activation_coverage.since?`Recorded since ${date(signals.activation_coverage.since)}`:"First successful execution"},{label:"Payments",icon:CreditCard,value:signals?.summary.payments,detail:signals&&ready?`${count(signals.summary.paying_accounts)} paying ${signals.summary.paying_accounts===1?"account":"accounts"} · ${money(signals.summary.amount_minor)} purchased`:"Completed credit purchases"}].map(({label,icon:Icon,value,detail})=><article className="metric" key={label}><div><h2>{label}</h2><Icon size={20}/></div><strong className="metric-value">{value!=null&&ready?count(value):"—"}</strong><p>{detail}</p></article>)}</div>
          <section className="panel"><div className="panel-heading"><h2>Daily activity</h2><span>Events during selected dates</span></div>{!signals?<Notice error={report.error} loading={report.loading}/>:!ready?<div className="empty-state"><Activity size={30}/><h3>No events collected yet</h3><p>The reporting connection is ready. The first collected events will appear here.</p></div>:<>
            {signals.activation_coverage.status!=="full"&&<p className="coverage-note">{signals.activation_coverage.status==="partial"?`First-run tracking covers only activity since ${date(signals.activation_coverage.since,true)}. Earlier dates are unavailable.`:signals.activation_coverage.status==="none"?`This range predates first-run tracking, which began ${date(signals.activation_coverage.since,true)}.`:"First successful executions are not currently being tracked. Sign-ups and purchases still come from Run’s database."}</p>}
            <div className="daily-table"><Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Sign-ups</TableHead><TableHead>Activated</TableHead><TableHead>Payments</TableHead><TableHead>Purchased</TableHead></TableRow></TableHeader><TableBody>{signals.daily.map(row=><TableRow key={row.date}><TableCell>{row.date}</TableCell><TableCell>{count(row.signups)}</TableCell><TableCell>{row.activations===null?"—":count(row.activations)}</TableCell><TableCell>{count(row.payments)}</TableCell><TableCell>{money(row.amount_minor)}</TableCell></TableRow>)}</TableBody></Table></div>
          </>}</section><p className="method-note">Counts reflect activity during the selected dates, not a sign-up cohort. Activation is a recorded first successful execution for accounts created since tracking began; some journeys may not be captured. Purchase amounts are gross, before refunds. Erased accounts and staff identified by tracking are excluded; staff may be included before tracking identifies them.</p>
        </TabsContent>
        <TabsContent value="journeys"><section className="panel"><div className="panel-heading"><h2>User journeys</h2><span>Accounts active during selected dates</span></div>{!journeys?<Notice error={report.error} loading={report.loading}/>:journeys.items.length===0?<div className="empty-state"><Users size={30}/><h3>{ready?"No account activity in this range":"No journeys collected yet"}</h3><p>{ready?"Try a different date range to find accounts with recorded activity.":"Accounts will appear after production tracking starts collecting their journeys."}</p></div>:<><Table><TableHeader><TableRow><TableHead>Account</TableHead><TableHead>First arrival</TableHead><TableHead>Events</TableHead><TableHead>Payments</TableHead><TableHead>Last activity</TableHead></TableRow></TableHeader><TableBody>{journeys.items.map(row=><TableRow key={row.account_ref}><TableCell><Button variant="link" className="account-label" onClick={()=>setSelected(row.account_ref)} title={row.account_ref} aria-label={`View journey for ${accountName(row)}`}>{accountName(row)}</Button><span className="cell-meta">Signed up {date(row.signup_at)}</span></TableCell><TableCell>{row.acquisition.source||"Not captured"}<span className="cell-meta">{row.acquisition.medium||"Source unavailable"}</span></TableCell><TableCell>{count(row.events_in_range)}</TableCell><TableCell>{count(row.payments)}<span className="cell-meta">{money(row.amount_minor)}</span></TableCell><TableCell>{date(row.last_active_at,true)}</TableCell></TableRow>)}</TableBody></Table></>}
          {journeys&&(cursors.length>0||journeys.next_cursor)&&<div className="pagination"><Button variant="outline" onClick={()=>setCursors(c=>c.slice(0,-1))} disabled={!cursors.length}>Previous</Button><span>Page {cursors.length+1}</span><Button variant="outline" onClick={()=>setCursors(c=>[...c,journeys.next_cursor!])} disabled={!journeys.next_cursor}>Next</Button></div>}
          </section><p className="method-note">Events, payments, and last activity use the selected dates. First arrival and sign-up use the account’s recorded history. Accounts currently use anonymous IDs.</p></TabsContent>
      </Tabs>
      {report.data&&report.data.kind!=="signals"&&<Coverage report={report.data}/>}
      {signals&&<p className="coverage">Report updated {date(signals.generated_at,true)} · Run database</p>}
    </section>
    <Sheet open={!!selected} onOpenChange={open=>{if(!open)setSelected(null);}}><SheetContent className="admin-analytics journey-sheet"><SheetHeader><SheetTitle>Account journey</SheetTitle><SheetDescription>{calendarLabel(range)} · Central Time</SheetDescription></SheetHeader>{selected&&<JourneyDetail key={`${selected}-${JSON.stringify(range)}-${refresh}`} accountRef={selected} range={range} refresh={refresh}/>}</SheetContent></Sheet>
  </div>;
}
function JourneyDetail({accountRef,range,refresh}:{accountRef:string;range:ReportRange;refresh:number}) {
  const [cursors,setCursors]=useState<string[]>([]);
  const {data,error,loading}=useReport<JourneyReport>({schema_version:1,kind:"journey",...range,account_ref:accountRef,...(cursors.length?{cursor:cursors.at(-1)}:{})},refresh);
  if(!data)return <Notice error={error} loading={loading}/>;
  const row=data.account;
  return <div className="journey-detail"><div className="account-identity"><h2>{accountName(row)}</h2><p>{row.account_ref}</p></div><section className="journey-summary"><h3>Journey summary</h3><p>{row.summary}</p></section>
    <h3 className="detail-heading">Recorded account history</h3><dl className="history-grid"><div><dt>First source</dt><dd>{row.acquisition.source||"Not captured"}{row.acquisition.medium?` / ${row.acquisition.medium}`:""}</dd></div><div><dt>First landing page</dt><dd>{row.acquisition.landing_path||"Not captured"}</dd></div><div><dt>Campaign</dt><dd>{row.acquisition.campaign||"Not captured"}</dd></div><div><dt>Sales-to-Run handoff</dt><dd>{({matched:"Click matched",unmatched_param:"Link present · click missing",cookie_only:"Browser link only",none:"Not captured"} as Record<string,string>)[row.acquisition.handoff_status]||row.acquisition.handoff_status}</dd></div><div><dt>Signed up</dt><dd>{date(row.signup_at,true)}</dd></div><div><dt>First activation</dt><dd>{date(row.activated_at,true)}</dd></div></dl>
    <div className="timeline-heading"><h3>Activity in selected dates</h3><span>{count(row.events_in_range)} {row.events_in_range===1?"event":"events"} · {money(row.amount_minor)} purchased</span></div>
    {data.events.length?<ol className="timeline">{data.events.map(event=><li key={event.event_id}><span className={`event-marker ${event.source_app==="run"?"run":"sales"}`}><MousePointerClick size={14}/></span><div><div className="event-title"><strong>{eventName(event.name)}</strong><span>{event.source_app==="run"?"Run":"Sales site"}</span></div><time dateTime={event.occurred_at}>{date(event.occurred_at,true)}</time>{event.page_path&&<p className="event-page">{event.page_host}{event.page_path}</p>}{Object.keys(event.properties).length>0&&<details className="event-properties"><summary>Event details</summary><dl>{Object.entries(event.properties).map(([key,value])=><div key={key}><dt>{key==="amount_minor"?"Amount":key.replaceAll("_"," ")}</dt><dd>{key==="amount_minor"&&typeof value==="number"?money(value):typeof value==="boolean"?(value?"Yes":"No"):String(value)}</dd></div>)}</dl></details>}</div></li>)}</ol>:<p className="method-note">No recorded activity for this account during the selected dates.</p>}
    {(cursors.length>0||data.next_cursor)&&<div className="pagination"><Button variant="outline" disabled={!cursors.length} onClick={()=>setCursors(c=>c.slice(0,-1))}>Earlier events</Button><span>Page {cursors.length+1}</span><Button variant="outline" disabled={!data.next_cursor} onClick={()=>setCursors(c=>[...c,data.next_cursor!])}>Later events</Button></div>}
  </div>;
}
