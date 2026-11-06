/** Local-only alarm observations and settlement fault injection. */
import { CamelAgent as RuntimeAgent, type Env } from "../src/agent.ts";
export * from "../src/index.ts";
export { default } from "../src/index.ts";

export class CamelAgent extends RuntimeAgent {
  private wakeCount = 0;
  private failNextWaiter = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const runtime = this as unknown as { settle(id: string, waitMs: number): Promise<unknown> };
    const settle = runtime.settle.bind(this);
    runtime.settle = (id, waitMs) => {
      if (this.failNextWaiter && waitMs === 0) {
        this.failNextWaiter = false;
        return Promise.reject(new Error("Injected result waiter interruption"));
      }
      return settle(id, waitMs);
    };
  }

  async onJob(context: { job: { fn: string } }) {
    if (context.job.fn === "camel-wake") this.wakeCount++;
    return super.onJob(context);
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/alarm-state")
      return Response.json({
        wakes: this.wakeCount,
        profile: await this.databaseProfile(),
        pending: (await this.ctx.storage.list({ prefix: "billing:" })).size,
        alarm: await this.ctx.storage.getAlarm(),
      });
    if (path === "/__test/delete-before-billing-retry" && request.method === "POST") {
      // A committed receipt lost its acknowledgement just as the agent was
      // deleted. Clear the old alarm so the real arm() must preserve its retry.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put("deleted", true);
      await this.ctx.storage.delete("test:crash-owner");
      await (this as unknown as { arm(retry: number): Promise<void> }).arm(Date.now() + 100);
      return Response.json({ armed: true });
    }
    if (path === "/__test/fail-next-waiter" && request.method === "POST") {
      this.failNextWaiter = true;
      return Response.json({ armed: true });
    }
    return super.fetch(request);
  }
}
