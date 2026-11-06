/** Local-only alarm observations and settlement fault injection. */
import { CamelAgent as RuntimeAgent } from "../src/agent.ts";
import { ARM_AGENT } from "../src/agent-internals.ts";
export * from "../src/index.ts";
export { default } from "../src/index.ts";

export class CamelAgent extends RuntimeAgent {
  private wakeCount = 0;

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
      await this[ARM_AGENT](Date.now() + 100);
      return Response.json({ armed: true });
    }
    if (path === "/__test/fail-next-waiter" && request.method === "POST") {
      await this.ctx.storage.put("test:fail-next-waiter", true);
      return Response.json({ armed: true });
    }
    return super.fetch(request);
  }
}
