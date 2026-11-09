import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "@/components/common";
import { api, useApi } from "@/lib/api";

type Trigger={id:string;name:string;mode:string};
export function AgentTriggers({agentId}:{agentId:string}) {
 const base=`/v1/agents/${agentId}/triggers`,list=useApi<Trigger[]>(base,15000);
 const [name,setName]=useState(''),[prompt,setPrompt]=useState(''),[mode,setMode]=useState('continue'),[verify,setVerify]=useState('none'),[secret,setSecret]=useState(''),[budget,setBudget]=useState('1'),[url,setUrl]=useState(''),[error,setError]=useState<string>(),[deliveries,setDeliveries]=useState<unknown>(),[busy,setBusy]=useState(false);
 async function write(action:()=>Promise<void>){setBusy(true);setError(undefined);try{await action();await list.reload();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 return <div className="space-y-4"><ErrorAlert error={error??list.error}/>
  <form className="space-y-3" onSubmit={e=>{e.preventDefault();void write(async()=>{const made=await api<{url:string}>(base,{body:{name,prompt,mode,budget:{usd:Number(budget)},verify:{type:verify,...(verify!=='none'?{secret}:{})}}});setUrl(made.url);setSecret('');});}}>
   <label>Name<Input value={name} onChange={e=>setName(e.target.value)} required/></label>
   <label>Instructions<Textarea value={prompt} onChange={e=>setPrompt(e.target.value)} required/></label>
   <label>Mode<select value={mode} onChange={e=>setMode(e.target.value)}><option value="continue">Continue</option><option value="fresh">Fresh from definition</option></select></label>
   <label>Verification<select value={verify} onChange={e=>setVerify(e.target.value)}>{['none','github','stripe','slack'].map(v=><option key={v}>{v}</option>)}</select></label>
   {verify!=='none'&&<label>Signing secret<Input type="password" value={secret} onChange={e=>setSecret(e.target.value)} required minLength={16}/></label>}
   <label>Maximum USD per run<Input type="number" min="0.01" step="0.01" value={budget} onChange={e=>setBudget(e.target.value)} required/></label>
   <Button disabled={busy}>Create trigger</Button>
  </form>
  {url&&<div className="space-y-2"><p>Copy this URL now. It is shown only once.</p><Input readOnly value={url}/><Button onClick={()=>void navigator.clipboard.writeText(url)}>Copy URL</Button><p>Platform request logs may include URL tokens. If your sender supports custom headers, use <code>{new URL(url).origin}/v1/hooks</code> and set <code>X-Camelrun-Hook-Token</code>.</p><Button variant="outline" onClick={()=>void navigator.clipboard.writeText(new URL(url).pathname.split('/').at(-1)!)}>Copy header token</Button><Button variant="outline" onClick={()=>setUrl('')}>Dismiss</Button></div>}
  {list.data?.map(t=><div key={t.id} className="flex flex-wrap gap-2 border p-3"><span>{t.name} · {t.mode}</span><Button disabled={busy} onClick={()=>void write(async()=>{const r=await api<{url:string}>(`${base}/${t.id}/rotate`,{body:{}});setUrl(r.url);})}>Rotate URL</Button><Button disabled={busy} onClick={()=>void write(async()=>{setDeliveries(await api(`${base}/${t.id}/deliveries`));})}>Deliveries</Button><Button disabled={busy} variant="outline" onClick={()=>void write(async()=>{await api(`${base}/${t.id}`,{method:'DELETE'});})}>Delete</Button></div>)}
  {deliveries!==undefined&&<pre className="overflow-auto text-xs">{JSON.stringify(deliveries,null,2)}</pre>}
 </div>;
}
