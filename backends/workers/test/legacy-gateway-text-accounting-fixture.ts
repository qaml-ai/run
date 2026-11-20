import { accountedLegacyGatewayText, type LegacyGatewayTextExecution } from "../src/legacy-gateway-text-accounting.ts";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { database, type PostgresEnv } from "../src/postgres.ts";
import type { LegacyGatewayTextRouteStore, LegacyGatewayTextRun } from "../src/legacy-gateway-text.ts";

export { LegacyGatewayTextRoutes } from "../src/legacy-gateway-text-routes.ts";

type Env = PostgresEnv & { ROUTES: { getByName(tenant: string): LegacyGatewayTextRouteStore } };

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    const { state, run, startedAt } = await request.json() as {
      state: "pending" | "ack-lost" | "missing" | "retry" | "expired" | "settled";
      run: LegacyGatewayTextRun;
      startedAt: number;
    };
    const store = env.ROUTES.getByName(run.legacyTenant);
    const owner = await store.pin(run.runId, { owner: "native", fingerprint: run.fingerprint, subject: run.subject, bucket: run.bucket });
    const terminal = () => Response.json({ id: run.runId, status: "completed", text: "fixture",
      usage: { input: 1000, output: 50, cacheRead: 1000, cacheWrite: 0, costUsd: 0.012 } });
    const execution: LegacyGatewayTextExecution = {
      run: async () => state === "pending" ? Response.json({ id: run.runId, status: "running" }, { status: 202 }) : terminal(),
      read: async () => state === "expired" ? new Response(null, { status: 404 }) : terminal(),
      billing: async () => {
        if (state === "pending") throw new Error("Pending response requested usage");
        if (state === "missing") return null;
        if (state === "settled") return { state: "settled" };
        return { state: "due", startedAt, input: 1000, output: 50, cacheRead: 1000, cacheWrite: 0 };
      },
      ackBilling: async () => {
        if (state === "ack-lost") throw new Error("Fixture lost ACK after committed debit");
      },
    };
    const runtime = accountedLegacyGatewayText(execution, new EndUserCredits(database(env)), "fixture");
    if (state !== "retry" && state !== "expired" && state !== "settled") return runtime.start(run);
    if (owner.owner !== "native") return new Response(null, { status: 409 });
    const { fingerprint, subject, bucket } = owner;
    return runtime.read(run.runId, { legacyTenant: run.legacyTenant, fingerprint, subject, bucket });
  },
};
