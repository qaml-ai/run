import { sweepInboxReceipts } from '../../../shared/inbox-answers.ts';

type Sql = { query(text: string, values?: any[]): Promise<{ rows: any[] }> };
/** Bounded fixture operations on the receipt table shared by both backends. */
export function inboxReceiptFixture(sql: Sql) {
  return {
    async ageInboxReceipt(requestId: string) {
      await sql.query("update inbox_answer_receipts set created_at=now()-interval '8 days' where tenant='alice' and request_id=$1", [requestId]);
    },
    async pruneInboxReceipts() {
      await sweepInboxReceipts(sql);
      return Number((await sql.query("select count(*) from inbox_answer_receipts where created_at <= now()-interval '7 days'")).rows[0].count);
    },
  };
}
