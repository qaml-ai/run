// Isolated real-Workers capability probe. The authority below is a FAKE, never Postgres or money.
import { DurableObject } from "cloudflare:workers";
import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { Buffer } from "node:buffer";
/* SOURCE_PASSWORD_METHODS */

export class FakeAuthority extends DurableObject {
  constructor(ctx: DurableObjectState, env: ProbeEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("create table if not exists receipts (id text primary key, amount integer not null)");
  }
  apply(id: string, amount: number) {
    this.ctx.storage.sql.exec("insert into receipts(id,amount) values(?,?) on conflict do nothing", id, amount);
    return this.state();
  }
  state() {
    return this.ctx.storage.sql.exec("select count(*) as charges, coalesce(sum(amount),0) as charged from receipts").one();
  }
}
type ProbeEnv = { OUTBOX: DurableObjectNamespace<OutboxProbe>; AUTHORITY: DurableObjectNamespace<FakeAuthority> };
export class OutboxProbe extends DurableObject<ProbeEnv> {
  private instance = crypto.randomUUID();
  async begin(id: string) {
    await this.ctx.storage.put("pending", { id, amount: 3750 });
    return this.state();
  }
  async commit(fault: boolean) {
    const receipt = await this.ctx.storage.get<{ id: string; amount: number }>("pending");
    if (receipt) {
      await this.env.AUTHORITY.getByName("fake-ledger").apply(receipt.id, receipt.amount);
      if (fault && !await this.ctx.storage.get("crashed")) {
        await this.ctx.storage.put("crashed", true);
        await this.ctx.storage.sync();
        this.ctx.abort("Injected reset after fake-authority commit, before outbox ack");
      }
      await this.ctx.storage.delete("pending");
    }
    return this.state();
  }
  async state() {
    return { instance: this.instance, pending: !!await this.ctx.storage.get("pending"), crashed: !!await this.ctx.storage.get("crashed"), authority: await this.env.AUTHORITY.getByName("fake-ledger").state() };
  }
}

// build-cloud-money-probe.mjs appends Accounts.seal/unseal unchanged under this class.
export class CryptoProbe {
  private secretsKey = Buffer.alloc(32, 0xab);
  /* SOURCE_CRYPTO_METHODS */
}
export default {
  async fetch(request: Request, env: ProbeEnv) {
    const url = new URL(request.url), name = url.searchParams.get("id");
    if (url.pathname === "/password") {
      const start = Date.now();
      const hash = await hashPassword("cloud-probe-fixture-caf\u00e9");
      const hashMs = Date.now() - start, verifyStart = Date.now();
      const verified = await verifyPassword("cloud-probe-fixture-cafe\u0301", hash);
      return Response.json({ verified, scheme: hash.split("$").slice(0, 4), hashMs, verifyMs: Date.now() - verifyStart, totalMs: Date.now() - start });
    }
    if (url.pathname === "/crypto") {
      const crypto = new CryptoProbe();
      const sealed = crypto.seal("fixture:provider", "not-a-real-credential");
      const aadRejected = (() => { try { crypto.unseal("other:provider", sealed); return false; } catch { return true; } })();
      return Response.json({ roundTrip: crypto.unseal("fixture:provider", sealed) === "not-a-real-credential", aadRejected, ivBytes: Buffer.from(sealed.iv, "base64").length, tagBytes: Buffer.from(sealed.tag, "base64").length });
    }
    if (!name || !/^[a-z0-9-]{8,80}$/.test(name)) return new Response("probe id required", { status: 400 });
    const outbox = env.OUTBOX.getByName(name);
    try {
      if (url.pathname === "/begin") return Response.json(await outbox.begin(name));
      if (url.pathname === "/commit") return Response.json(await outbox.commit(url.searchParams.has("fault")));
      if (url.pathname === "/state") return Response.json(await outbox.state());
      return new Response("not found", { status: 404 });
    } catch {
      return Response.json({ interrupted: true }, { status: 503 });
    }
  },
};
