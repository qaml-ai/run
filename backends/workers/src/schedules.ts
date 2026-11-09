import { freshAutomationRun } from '../../../src/core/fresh-runs.ts';
import { workerFreshRunHost } from './fresh-runs.ts';
import { readScheduleRuns, recordScheduleRun, reserveFreshScheduleRun, scheduleRunMetadata } from '../../../src/core/schedule-runs.ts';
import { calendarPrompt } from '../../../src/calendar.ts';
import { Directory } from './control.ts';
import { provisionDefinition } from './definitions.ts';
import { scheduleInput, MIN_REPEAT_SECONDS, type Schedule, type ScheduleEmail } from './schedule-policy.ts';
import { HttpError } from './errors.ts';
import { digest } from './api-contract.ts';
import { withSql, transaction } from './postgres.ts';
import { markdownEmail } from '../../../src/markdown-email.ts';
import { readableText } from '../../../src/html-text.ts';
import { failure, metric } from './observability.ts';
import type { WebhookEnv } from './webhooks.ts';
import { createTenants } from './security-services.ts';

export interface ScheduleEnv extends WebhookEnv {
  AGENTS: { getByName(id:string): {fetch(request:Request):Promise<Response>} };
  SCHEDULE_EMAIL_FROM?: string;
  SCHEDULE_OPERATOR_TENANTS?: string;
  AGENT_ACCOUNT_EMAIL_FROM?: string;
  AGENT_TENANTS_JSON?: string;
}
export type StoredSchedule = Schedule & { retryAt?: number; attempts?: number };
/** Same recipient rules as src/node.ts, checked both when scheduling and sending. */
export async function canScheduleEmail(env: ScheduleEnv, tenant: string, to: string) {
  const email=to.toLowerCase();
  const operator=(env.SCHEDULE_OPERATOR_TENANTS??'').split(',').includes(tenant) || (await createTenants(env)).has(tenant);
  const allowed=operator || !!(await withSql(env,sql=>sql.query(`select 1 from tenants where id=$1 and lower(google_email)=$2
    union all select 1 from tenant_passwords where tenant=$1 and lower(email)=$2
    union all select 1 from billing_recipients where tenant=$1 and email=$2 and status='verified' limit 1`,[tenant,email]))).rowCount;
  const hash = await digest(email);
  return allowed && !(await withSql(env,sql=>sql.query('select 1 from billing_email_suppressions where email_hash=$1',[hash]))).rowCount;
}
export async function newSchedule(env:ScheduleEnv,tenant:string,agent:string,raw:unknown):Promise<StoredSchedule> {
  let input:ReturnType<typeof scheduleInput>;
  try { input=scheduleInput(raw); } catch(error) { throw new HttpError(400,(error as Error).message); }
  const content=input.text??input.code;
  if((input.text===undefined)===(input.code===undefined)||typeof content!=='string'||!content.trim()||content.length>32000)throw new HttpError(400,'Give exactly one of text or code (1–32000 characters)');
  if(input.everySeconds!==undefined&&(!Number.isInteger(input.everySeconds)||input.everySeconds<MIN_REPEAT_SECONDS))throw new HttpError(400,`everySeconds must be an integer of at least ${MIN_REPEAT_SECONDS}`);
  if(input.history!==undefined&&!['full','none'].includes(input.history))throw new HttpError(400,'history must be full or none');
  if(input.email) {
    if(!(env.SCHEDULE_EMAIL_FROM || env.AGENT_ACCOUNT_EMAIL_FROM))throw new HttpError(400,'Scheduled email is not enabled on this runtime');
    if(input.code!==undefined)throw new HttpError(400,'Email delivery requires a text schedule');
    if(!await canScheduleEmail(env,tenant,input.email.to))throw new HttpError(403,'Use your sign-in email or a verified billing recipient for scheduled reports');
  }
  const {history,...rest}=input;
  return {id:crypto.randomUUID(),agent,tenant,sessionMode:"continue",...rest,dueAt:Math.round(input.dueAt),createdAt:Date.now()};
}
export async function scheduleDeliveries(env:ScheduleEnv,tenant:string,agent:string) {
 return withSql(env,sql=>readScheduleRuns(sql,tenant,agent));
}
export async function queueScheduleEmail(env:ScheduleEnv,schedule:StoredSchedule,id:string) {
 if(!schedule.email)return;
 await withSql(env,sql=>sql.query('insert into schedule_deliveries(id,tenant,agent,schedule,email,created_at,next_at) values($1,$2,$3,$4,$5,$6,$6) on conflict do nothing',[id,schedule.tenant,schedule.agent,schedule.id,schedule.email,Date.now()]));
}
/** Queue repair is backed by SQL; a crash between intent and Queue publication is harmless. */
export async function publishScheduleEmails(env:ScheduleEnv) {
 if(!env.WEBHOOKS)return;
 const rows=(await withSql(env,sql=>sql.query("select id from schedule_deliveries where state='waiting' and next_at<=$1 and (lease_until is null or lease_until<=$1) order by next_at limit 100",[Date.now()]))).rows;
 if(rows.length)await env.WEBHOOKS.sendBatch(rows.map(row=>({body:{id:row.id,kind:'schedule' as const}})));
}
/** Delivery is at-least-once if the mail service accepts a send whose answer is lost. */
export async function deliverScheduleEmail(env:ScheduleEnv,id:string) {
 const now=Date.now(),lease=crypto.randomUUID();
 const row=(await withSql(env,sql=>sql.query("update schedule_deliveries set lease=$2,lease_until=$3 where id=$1 and state='waiting' and next_at<=$4 and (lease_until is null or lease_until<=$4) returning *",[id,lease,now+60000,now]))).rows[0];
 if(!row) {
   const waiting = (await withSql(env,sql=>sql.query("select 1 from schedule_deliveries where id=$1 and state='waiting'",[id]))).rowCount;
   return !waiting;
 }
 const finish=(state:string,error?:string,messageId?:string)=>withSql(env,sql=>sql.query('update schedule_deliveries set state=$3,error=$4,message_id=$5,sent_at=$6,lease=null,lease_until=null where id=$1 and lease=$2',[id,lease,state,error??null,messageId??null,state==='sent'?Date.now():null]));
 try {
  const abort=new AbortController();
  const deadline=setTimeout(()=>abort.abort(new DOMException('Scheduled run read timed out','TimeoutError')),15000);
  let record:any;
  try {
   const response=await env.AGENTS.getByName(row.agent).fetch(new Request(`https://agent/requests/${encodeURIComponent(id)}`,{signal:abort.signal}));
   if(!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status,'Scheduled run could not be read');
   }
   record=await response.json();
  } finally {clearTimeout(deadline);}
  if(record.state!=='completed') {
   if(now-Number(row.created_at)>48*3600000){await finish('failed','Run did not complete within 48 hours');return true;}
   await withSql(env,sql=>sql.query('update schedule_deliveries set next_at=$3,lease=null,lease_until=null where id=$1 and lease=$2',[id,lease,now+10000]));return false;
  }
  const result=record.outcome?.result;
  if(record.outcome?.error||result?.error||result?.stopped||!result?.reply){await finish('failed',"Scheduled run failed or returned no report; see the agent's run history");return true;}
  if(!await canScheduleEmail(env,row.tenant,row.email.to)){await finish('failed','Recipient is no longer verified or is suppressed');return true;}
  const reply=String(result.reply),format=row.email.format??'markdown';
  let messageId:string|undefined;
  if(env.TEST_MODE!=='1') {
   const from=env.SCHEDULE_EMAIL_FROM||env.AGENT_ACCOUNT_EMAIL_FROM;
   if(!env.MAIL||!from)throw Error('Schedule mail transport is not configured');
   // SendEmail has no AbortSignal. Renew only while the send is active; never
   // start it after another consumer has acquired the expired lease.
   const renew=async()=>{
    const at=Date.now();
    return !!(await withSql(env,sql=>sql.query("update schedule_deliveries set lease_until=$3 where id=$1 and lease=$2 and state='waiting' and lease_until>$4 returning id",[id,lease,at+60000,at]))).rowCount;
   };
   if(!await renew())return false;
   let renewing:Promise<void>|undefined;
   const timer=setInterval(()=>{
    if(renewing)return;
    renewing=renew().then(owned=>{if(!owned)clearInterval(timer);}).catch(error=>failure(env,'schedule_mail_lease_failed',error)).finally(()=>{renewing=undefined;});
   },20000);
   try {
    messageId=(await env.MAIL.send({from,to:row.email.to,subject:row.email.subject,headers:{'X-CamelRun-Delivery':id},text:format==='html'?readableText(reply).text:reply,...(format==='text'?{}:{html:format==='html'?reply:markdownEmail(reply)})})).messageId;
   } finally {clearInterval(timer);await renewing;}
  }
  if(!(await finish('sent',undefined,messageId)).rowCount)return false;
  metric(env,'schedule_mail',{ScheduleMailSent:1});return true;
 } catch(error) {
  failure(env,'schedule_mail_failed',error);
  const attempts=Number(row.attempts)+1,gone=[404,410].includes(Number((error as any)?.status));
  const failed=gone||attempts>=5;
  await withSql(env,sql=>sql.query('update schedule_deliveries set attempts=$3,state=$4,error=$5,next_at=$6,lease=null,lease_until=null where id=$1 and lease=$2',[id,lease,attempts,failed?'failed':'waiting',gone?'Agent no longer exists':'Delivery failed',now+Math.min(3600000,60000*2**(attempts-1))]));
  return failed;
 }
}

export async function deliverScheduledRun(env: any, schedule: StoredSchedule, id: string,
 submitLocal: (request:any)=>Promise<any>, background:(work:Promise<unknown>)=>void) {
 const source={tenant:schedule.tenant,agent:schedule.agent,schedule:schedule.id,createdAt:Date.now()};
 const report=(agent:string|null,record:any)=>withSql(env,sql=>recordScheduleRun(sql,source,agent,record)).catch(error=>failure(env,'schedule_outcome_failed',error));
 let agent=schedule.agent;
 try {
  if(schedule.sessionMode==='fresh') {
   const host=await workerFreshRunHost(env);
   agent=await freshAutomationRun({
    reserve:()=>transaction(env,sql=>reserveFreshScheduleRun(sql,source,id)),
    precheck:()=>host.precheck(schedule.tenant),
    definition:()=>host.definition(schedule.tenant,schedule.agent),
    upsert:(input,key)=>host.upsert(schedule.tenant,{...input,...(schedule.mounts?{mounts:schedule.mounts}:{})},key),
    record:async agent=>{await withSql(env,sql=>sql.query('update schedule_runs set run_agent=$2 where id=$1',[id,agent]));},
   },`schedule-${(await digest(id)).slice(0,40)}`);
  }
  const input={id,method:schedule.code===undefined?'prompt':'execute',params:{...(schedule.code===undefined?{text:schedule.calendar?calendarPrompt(schedule.text!,schedule.calendar,schedule.dueAt):schedule.text}:{code:schedule.code}),metadata:scheduleRunMetadata(source),allowDisconnected:true,...(schedule.spendLimit?{spendLimit:schedule.spendLimit}:{})}};
  let record:any;
  if(schedule.sessionMode!=='fresh') record=await submitLocal(input);
  else {
   const response=await env.AGENTS.getByName(agent).fetch(new Request('https://agent/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
   record=await response.json();
   if(!response.ok)throw new HttpError(response.status,record.error??'Delivery failed');
  }
  background(report(agent,record));
  if(schedule.email)background(queueScheduleEmail(env,{...schedule,agent},id).then(()=>publishScheduleEmails(env)).catch(error=>failure(env,'schedule_mail_queue_failed',error)));
  return {agent,requestId:id,record};
 } catch(error) {
  background(report(null,{id,state:'completed',endedAt:Date.now(),outcome:{error:error instanceof Error?error.message:String(error)}}));
  throw error;
 }
}
