import worker from "../src/index.ts";
import { VoiceCall as ProductionVoiceCall } from "../src/voice-call.ts";
import type { Env } from "../src/agent-types.ts";
import type { VoiceCredits } from "../src/voice/calls/money.ts";

export * from "./worker-entry.ts";

/** Binding-only fake ledger for verifying amounts and dedupe before the generated debit lands. */
export class VoiceCall extends ProductionVoiceCall {
  constructor(ctx: DurableObjectState, env: Env & { TEST_VOICE_CREDITS?: string }) {
    const payer = env.TEST_VOICE_CREDITS === "1";
    let depleted = false;
    const VOICE_CREDITS: VoiceCredits = {
      enabled: async () => payer,
      refusal: async (_tenant, subject) => payer && (subject === "empty" || depleted) ? { message: "No credit", reason: "balance" } : undefined,
      debit: async (_tenant, _subject, _bucket, usd, key, _metadata, { sql }) => {
        await sql.query("insert into voice_test_debits(key, usd) values($1,$2)", [key, usd]);
        if (env.TEST_VOICE_CREDITS === "1" && _subject === "drain") depleted = true;
      },
    };
    super(ctx, Object.assign(Object.create(env), { VOICE_CREDITS }));
  }

  async advance(kind: "expiry" | "pending" | "late" | "deadline") {
    const row = await this.ctx.storage.get<any>("call");
    if (kind === "expiry") row.call.expiresAt = Date.now() - 1;
    if (kind === "deadline") row.call.endedAt = Date.now() - 900_001;
    await this.ctx.storage.put("call", row);
    if (kind === "pending" || kind === "late") for (const [key, ask] of await this.ctx.storage.list<any>({ prefix: "ask:" })) {
      ask.started = Date.now() - (kind === "late" ? 300_001 : 45_001);
      await this.ctx.storage.put(key, ask);
    }
    await this.alarm();
  }
}

export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/voice-alarm" && request.headers.get("authorization") === `Bearer ${env.API_TOKEN}`) {
      const stub = env.VOICE_CALLS.getByName(url.searchParams.get("id")!) as unknown as DurableObjectStub<VoiceCall>;
      await stub.advance(url.searchParams.get("kind") as "expiry");
      return Response.json({});
    }
    return worker.fetch(request, env, ctx);
  },
};
