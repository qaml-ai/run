import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "@/components/common";
import { api, formatTime, useApi } from "@/lib/api";

type Schedule = { id: string; text?: string; dueAt: number; everySeconds?: number; calendar?: {time:string;timeZone:string;daysOfWeek?:number[]}; email?: {to:string;subject:string}; lastError?:string };
type Delivery = {id:string;state:string;createdAt:number;sentAt:number|null;error:string|null};
export function AgentSchedules({ agentId }: { agentId: string }) {
 const base=`/v1/agents/${agentId}`;
 const schedules=useApi<Schedule[]>(`${base}/schedules`,15000), deliveries=useApi<Delivery[]>(`${base}/schedule-deliveries`,15000);
 const [text,setText]=useState(""),[time,setTime]=useState("08:00"),[zone,setZone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone),[cadence,setCadence]=useState("daily"),[to,setTo]=useState(""),[subject,setSubject]=useState("Agent report"),[busy,setBusy]=useState(false),[error,setError]=useState<any>();
 async function write(action:()=>Promise<unknown>){setBusy(true);setError(undefined);try{await action();await schedules.reload();await deliveries.reload();}catch(e){setError(e);}finally{setBusy(false);}}
 return <div className="space-y-6">
  <ErrorAlert error={error??schedules.error??deliveries.error}/>
  <form className="max-w-2xl space-y-3" onSubmit={e=>{e.preventDefault();void write(async()=>{await api(`${base}/schedules`,{body:{text,history:"none",calendar:{time,timeZone:zone,...(cadence==="weekdays"?{daysOfWeek:[1,2,3,4,5]}:{})},...(to?{email:{to,subject}}:{})}});setText("");});}}>
   <h2 className="text-lg font-medium">Add a schedule</h2>
   <Label htmlFor="schedule-prompt">What should the agent do?</Label><Textarea id="schedule-prompt" value={text} onChange={e=>setText(e.target.value)} required maxLength={32000}/>
   <div className="flex flex-wrap gap-3"><label>Repeat<select aria-label="Repeat" className="block h-9 border bg-background px-2" value={cadence} onChange={e=>setCadence(e.target.value)}><option value="daily">Daily</option><option value="weekdays">Weekdays</option></select></label>
    <label>Local time<Input aria-label="Local time" type="time" value={time} onChange={e=>setTime(e.target.value)} required/></label>
    <label>Time zone<Input aria-label="Time zone" value={zone} onChange={e=>setZone(e.target.value)} required/></label></div>
   <p className="text-sm text-muted-foreground">Uses this local time through daylight saving changes. Each run starts with your prompt and the agent’s instructions, and can read its saved files.</p>
   <label className="block">Email the final report (optional)<Input aria-label="Email recipient" type="email" value={to} onChange={e=>setTo(e.target.value)} placeholder="you@example.com"/></label>
   <p className="text-sm text-muted-foreground">Use your sign-in email or a verified recipient from Billing email alerts.</p>
   {to&&<label className="block">Email subject<Input aria-label="Email subject" value={subject} onChange={e=>setSubject(e.target.value)} required maxLength={200}/></label>}
   <Button disabled={busy||!text.trim()}>Create schedule</Button>
  </form>
  <section><h2 className="mb-2 text-lg font-medium">Schedules</h2>{schedules.data?.length===0&&<p className="text-muted-foreground">No schedules yet.</p>}{schedules.data?.map(s=><div key={s.id} className="mb-2 flex items-start justify-between gap-4 border p-3"><div><p className="whitespace-pre-wrap">{s.text??"Sandboxed code"}</p><p className="text-sm text-muted-foreground">{s.calendar?`${s.calendar.time} ${s.calendar.timeZone}${s.calendar.daysOfWeek?` · days ${s.calendar.daysOfWeek.join(", ")}`:" · daily"}`:s.everySeconds?`Every ${s.everySeconds} seconds`:"Once"} · Next {formatTime(s.dueAt)}</p>{s.email&&<p className="text-sm">Email: {s.email.to}</p>}{s.lastError&&<p className="text-sm text-destructive">{s.lastError}</p>}</div><Button variant="outline" disabled={busy} onClick={()=>void write(()=>api(`${base}/schedules/${s.id}`,{method:"DELETE"}))}>Cancel</Button></div>)}</section>
  {!!deliveries.data?.length&&<section><h2 className="mb-2 text-lg font-medium">Email deliveries</h2>{deliveries.data.map(d=><div key={d.id} className="border-b py-2 text-sm">{formatTime(d.sentAt??d.createdAt)} · {d.state}{d.error&&` · ${d.error}`}</div>)}</section>}
 </div>;
}
