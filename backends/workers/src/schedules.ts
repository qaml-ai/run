import { scheduleInput, MIN_REPEAT_SECONDS, type Schedule, type ScheduleEmail } from './schedule-policy.ts';
import { HttpError } from './errors.ts';
import { digest } from './api-contract.ts';
import { withSql } from './postgres.ts';
import { markdownEmail } from '../../../src/markdown-email.ts';
import { readableText } from '../../../src/html-text.ts';
import { failure, metric } from './observability.ts';
import type { WebhookEnv } from './webhooks.ts';

export interface ScheduleEnv extends WebhookEnv {
  AGENTS: { getByName(id:string): {fetch(request:Request):Promise<Response>} };
  SCHEDULE_EMAIL_FROM?: string;
  SCHEDULE_OPERATOR_TENANTS?: string;
}
export type StoredSchedule = Schedule & { retryAt?: number; attempts?: number };
/** Same recipient rules as src/node.ts, checked both when scheduling and sending. */
export async function canScheduleEmail(env: ScheduleEnv, tenant: string, to: string) {
  const email=to.toLowerCase();
  const operator=(env.SCHEDULE_OPERATOR_TENANTS??'').split(',').includes(tenant);
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
    if(!env.SCHEDULE_EMAIL_FROM)throw new HttpError(400,'Scheduled email is not enabled on this runtime');
    if(input.code!==undefined)throw new HttpError(400,'Email delivery requires a text schedule');
    if(!await canScheduleEmail(env,tenant,input.email.to))throw new HttpError(403,'Use your sign-in email or a verified billing recipient for scheduled reports');
  }
  const {history,...rest}=input;
  return {id:crypto.randomUUID(),agent,tenant,...rest,dueAt:Math.round(input.dueAt),createdAt:Date.now()};
}
export async function scheduleDeliveries(env:ScheduleEnv,tenant:string,agent:string) {
 return (await withSql(env,sql=>sql.query('select id,state,email,created_at as "createdAt",sent_at as "sentAt",message_id as "messageId",error from schedule_deliveries where tenant=$1 and agent=$2 order by created_at desc limit 100',[tenant,agent]))).rows;
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
   if(!env.MAIL||!env.SCHEDULE_EMAIL_FROM)throw Error('Schedule mail transport is not configured');
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
    messageId=(await env.MAIL.send({from:env.SCHEDULE_EMAIL_FROM,to:row.email.to,subject:row.email.subject,headers:{'X-CamelRun-Delivery':id},text:format==='html'?readableText(reply).text:reply,...(format==='text'?{}:{html:format==='html'?reply:markdownEmail(reply)})})).messageId;
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
