import { DurableObject } from "cloudflare:workers";
import { Client } from "pg";

type Operation = "charge" | "reserve" | "settle";
type Input = {
  operation: Operation;
  tenant: string;
  id: string;
  reserve: number;
  cost: number;
  failAfterLedger?: boolean;
  loseAcknowledgement?: boolean;
};

/** A paid-credit SQL proof, not the complete production billing policy. */
export class CreditsProbe extends DurableObject<Env> {
  async transact(input: Input) {
    const began = performance.now();
    // Operation and injected faults can change across retries; the paid call's
    // tenant, identity, reservation and final cost cannot.
    const immutable = JSON.stringify([input.tenant, input.id, input.reserve, input.cost]);
    const payloadHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(immutable))))
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const client = new Client({ connectionString: this.env.HYPERDRIVE.connectionString,
      connectionTimeoutMillis: 5_000, query_timeout: 10_000, application_name: "camelrun-proto-hybrid" });
    await client.connect();
    const connected = performance.now();
    let result: { status: string; balance: number; held: number };
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '5s'");
      const account = (await client.query("select balance from credit_accounts where tenant = $1 for update", [input.tenant])).rows[0];
      if (!account) throw new Error("missing fixture account");
      const balance = Number(account.balance);
      const key = `hybrid:${input.tenant}:${input.id}`;
      const prior = (await client.query("select amount, metadata from credit_ledger where idempotency_key = $1", [key])).rows[0];
      if (prior) {
        if (Number(prior.amount) !== -input.cost || prior.metadata.payloadHash !== payloadHash) throw new Error("idempotency payload mismatch");
        result = { status: "duplicate", balance, held: 0 };
      } else {
        const now = Date.now();
        await client.query("delete from credit_holds where tenant = $1 and expires_at <= $2", [input.tenant, now]);
        let hold = (await client.query("select tenant, amount from credit_holds where id = $1", [input.id])).rows[0];
        if (hold && hold.tenant !== input.tenant) throw new Error("reservation owner mismatch");
        if (input.operation !== "settle") {
          if (hold && Number(hold.amount) !== input.reserve) throw new Error("reservation payload mismatch");
          const held = Number((await client.query("select coalesce(sum(amount), 0) as held from credit_holds where tenant = $1", [input.tenant])).rows[0].held);
          if (!hold && input.reserve > balance - held) {
            result = { status: "insufficient", balance, held };
          } else {
            if (!hold) {
              await client.query("insert into credit_holds (id, tenant, amount, expires_at, created_at) values ($1, $2, $3, $4, $5)", [input.id, input.tenant, input.reserve, now + 600_000, now]);
              hold = { tenant: input.tenant, amount: input.reserve };
            }
            result = { status: "reserved", balance, held: Number(hold.amount) };
          }
        } else result = { status: "reserved", balance, held: Number(hold?.amount ?? 0) };
        if (input.operation !== "reserve" && result.status !== "insufficient") {
          if (!hold || input.cost > Number(hold.amount)) throw new Error("missing or inadequate reservation");
          // Same atomic ledger/balance movement as postLedger, plus spend-minute
          // and receipt uniqueness as in the production usage-flush transaction.
          await client.query(`with appended as (
            insert into credit_ledger (tenant, kind, amount, idempotency_key, metadata, created_at)
            values ($1, 'usage', -$2::bigint, $3, $4::jsonb, $5)
            on conflict (idempotency_key) do nothing returning tenant, amount
          ) update credit_accounts a set balance = a.balance + p.amount
            from appended p where a.tenant = p.tenant`,
          [input.tenant, input.cost, key, JSON.stringify({ probe: true, receipt: input.id, payloadHash }), now]);
          await client.query(`insert into credit_spend_minutes (tenant, minute, amount) values ($1, $2, $3)
            on conflict (tenant, minute) do update set amount = credit_spend_minutes.amount + excluded.amount`,
          [input.tenant, Math.floor(now / 60_000), input.cost]);
          await client.query("insert into usage_flushes (id) values ($1)", [input.id]);
          await client.query("delete from credit_holds where id = $1 and tenant = $2", [input.id, input.tenant]);
          if (input.failAfterLedger) throw new Error("injected rollback");
          result = { status: "committed", balance: balance - input.cost, held: 0 };
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      // Particularly important for DOs: do not pin one origin connection per agent.
      await client.end();
    }
    if (input.loseAcknowledgement) throw new Error("injected lost commit acknowledgement");
    return { ...result, connectionMs: connected - began, transactionAndCloseMs: performance.now() - connected,
      totalMs: performance.now() - began };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // This probe has no production auth. Both this guard and the runner's binding
    // make it local only; it must not be deployed as a public API.
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response("local only", { status: 403 });
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (request.method !== "POST") return new Response("method", { status: 405 });
    const input = await request.json() as Input;
    if (!["charge", "reserve", "settle"].includes(input.operation) ||
      !/^camelrun-proto-[a-z0-9-]+$/.test(input.tenant) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.id) ||
      !Number.isSafeInteger(input.reserve) || input.reserve <= 0 ||
      !Number.isSafeInteger(input.cost) || input.cost <= 0 || input.cost > input.reserve) {
      return new Response("invalid fixture input", { status: 400 });
    }
    try {
      return Response.json(await env.CREDITS.getByName(url.pathname.slice(1) || "agent").transact(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "probe failure";
      const known = ["injected rollback", "injected lost commit acknowledgement", "idempotency payload mismatch",
        "reservation payload mismatch", "reservation owner mismatch", "missing or inadequate reservation"];
      // Never reflect driver messages, URLs or credentials in diagnostics.
      return Response.json({ error: known.find(item => message.includes(item)) ?? "database operation failed" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
