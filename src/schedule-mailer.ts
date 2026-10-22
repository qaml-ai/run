import { randomUUID } from "node:crypto";
import { readableText } from "./html-text.ts";
import { markdownEmail } from "./markdown-email.ts";
import type { Db } from "./db.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { MailTransport, type MailTransportOptions, type OutgoingMail } from "./mail-transport.ts";

/** Durable delivery of successful scheduled runs. SES is at-least-once if a send's answer is lost. */
export class ScheduleMailer {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private transport?: MailTransport;
  private readonly options: {
    db: Db; mail?: MailTransportOptions;
    request(agent: string, tenant: string, id: string, signal: AbortSignal): Promise<RequestRecord | undefined>;
    canEmail?: (tenant: string, to: string) => Promise<boolean>;
    send?: (mail: OutgoingMail, signal: AbortSignal) => Promise<{ messageId?: string }>;
  };
  constructor(options: ScheduleMailer["options"]) { this.options = options; }
  start(interval = 5_000) { this.timer ??= setInterval(() => void this.pump().catch(() => console.error(JSON.stringify({ type: "schedule_mail_poll_failed" }))), interval); this.timer.unref(); }
  async stop() { clearInterval(this.timer); await this.active; this.transport?.destroy(); }
  pump() { return this.active ??= this.deliver().finally(() => { this.active = undefined; }); }
  private async deliver() {
    const now = Date.now(), lease = randomUUID(), db = this.options.db;
    const { rows } = await db.query(`update schedule_deliveries set lease=$1, lease_until=$2 where id in (
      select id from schedule_deliveries where state='waiting' and next_at <= $3 and (lease_until is null or lease_until <= $3)
      order by next_at limit 5 for update skip locked) returning *`, [lease, now + 60_000, now]);
    await Promise.all(rows.map(async row => {
      const finish = (state: string, error?: string, message?: string) => db.query("update schedule_deliveries set state=$3,error=$4,message_id=$5,sent_at=$6,lease=null,lease_until=null where id=$1 and lease=$2", [row.id,lease,state,error ?? null,message ?? null,state === "sent" ? Date.now() : null]);
      try {
        const record = await this.options.request(row.agent, row.tenant, row.id, AbortSignal.timeout(15_000));
        if (!record || record.state !== "completed") {
          if (now - Number(row.created_at) > 48 * 3_600_000) { await finish("failed", "Run did not complete within 48 hours"); return; }
          await db.query("update schedule_deliveries set next_at=$3,lease=null,lease_until=null where id=$1 and lease=$2", [row.id,lease,now+10_000]); return;
        }
        const result = record.outcome?.result as { error?: unknown; stopped?: unknown; reply?: unknown } | undefined;
        if (record.outcome?.error || result?.error || result?.stopped || !result?.reply) { await finish("failed", "Scheduled run failed or returned no report; see the agent's run history"); return; }
        if (this.options.canEmail && !await this.options.canEmail(row.tenant, row.email.to)) { await finish("failed", "Recipient is no longer verified or is suppressed"); return; }
        const reply = String(result.reply), format = row.email.format ?? "markdown";
        const mail: OutgoingMail = { to: row.email.to, subject: row.email.subject,
          text: format === "html" ? readableText(reply).text : reply,
          ...(format === "text" ? {} : { html: format === "html" ? reply : markdownEmail(reply) }),
          headers: [{ Name: "X-CamelRun-Delivery", Value: row.id }], tags: [{ Name: "product", Value: "camelrun-schedule" }] };
        this.transport ??= this.options.mail ? new MailTransport(this.options.mail) : undefined;
        const sent = this.options.send ? await this.options.send(mail, AbortSignal.timeout(15_000)) : await this.transport!.send(mail, AbortSignal.timeout(15_000));
        if ("suppressed" in sent) { await finish("failed", "Recipient suppressed"); return; }
        await finish("sent", undefined, sent.messageId);
      } catch (error) {
        const attempts = Number(row.attempts) + 1;
        // No report, recipient, or provider error text in logs; the operator can inspect the delivery id.
        console.error(JSON.stringify({ type: "schedule_mail_failed", delivery: row.id, attempts }));
        const gone = [404,410].includes(Number((error as any)?.status));
        await db.query("update schedule_deliveries set attempts=$3,state=$4,error=$5,next_at=$6,lease=null,lease_until=null where id=$1 and lease=$2", [row.id,lease,attempts,gone || attempts >= 5 ? "failed" : "waiting",gone ? "Agent no longer exists" : "Delivery failed",now + Math.min(3_600_000,60_000 * 2 ** (attempts-1))]);
      }
    }));
  }
}
