/** Local-only alarm observations and settlement fault injection. */
import { CamelAgent as RuntimeAgent } from "../src/agent.ts";
import { ARM_AGENT, testAgentRuntimes } from "../src/agent-internals.ts";
export * from "../src/index.ts";
export { default } from "../src/index.ts";

export class CamelAgent extends RuntimeAgent {
  private wakeCount = 0;
  private raceTracker?: Promise<unknown>;

  private forceObserverSettlement() {
    const runtime = testAgentRuntimes.get(this)!;
    const resumeTracker = Promise.withResolvers<void>();
    const trackerFlushing = Promise.withResolvers<void>();
    const wait = runtime.harness.wait.bind(runtime.harness);
    const flush = runtime.flushBilling.bind(runtime);
    const get = runtime.testStorage.get.bind(runtime.testStorage);

    runtime.harness.wait = async (id, options) => {
      if (options?.signal) return wait(id, options);
      runtime.harness.wait = wait;
      const result = await wait(id, options);
      await resumeTracker.promise;
      return result;
    };
    runtime.flushBilling = (propagate = false) => {
      const pass = flush(propagate);
      if (propagate) {
        runtime.flushBilling = flush;
        this.raceTracker = pass;
        trackerFlushing.resolve();
      }
      return pass;
    };
    runtime.testStorage.get = async <T>(key: `test:${string}`) => {
      if (key === "test:crash-settlement") {
        // The observer committed completion and settled in PG. Hold its receipt
        // in storage while the tracker sees completion and calls flushBilling.
        runtime.testStorage.get = get;
        resumeTracker.resolve();
        await trackerFlushing.promise;
        // An unqueued tracker can settle the same receipt while it is held.
        await Promise.race([this.raceTracker, new Promise(resolve => setTimeout(resolve, 250))]);
      }
      return get<T>(key);
    };
  }

  async onJob(context: { job: { fn: string } }) {
    if (context.job.fn === "camel-wake") this.wakeCount++;
    return super.onJob(context);
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/observer-settlement-race" && this.env.TEST_HOOKS === "1") {
      if (request.method === "POST") {
        this.forceObserverSettlement();
        return Response.json({ armed: true });
      }
      await this.raceTracker;
      return Response.json({ trackerFlushed: this.raceTracker !== undefined });
    }
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
