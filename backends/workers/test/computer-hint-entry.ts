import type { Placement } from "../../../shared/owner.ts";
import { CamelAgent as RuntimeAgent } from "../src/agent.ts";
import { COMPUTER_ATTACHED } from "../src/agent-lifecycle.ts";

export * from "../src/index.ts";
export { default } from "../src/index.ts";

export class CamelAgent extends RuntimeAgent {
  async admitDelegated(request: unknown, placement: Placement) {
    if (this.env.TEST_HOOKS === "1" && this.env.PILOT_DB_PROFILE === "1") {
      const afterInheritance = await this.ctx.storage.get(COMPUTER_ATTACHED);
      await this.databaseProfile(true);
      // Before the child's first tool discovery can overwrite the hint, exercise its real wake.
      await this.onJob({ job: { fn: "camel-wake" } });
      await this.ctx.storage.put("test:after-inheritance", {
        hint: afterInheritance ?? null,
        profile: await this.databaseProfile(),
      });
    }
    return super.admitDelegated(request, placement);
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (this.env.TEST_HOOKS === "1") {
      if (path === "/__test/computer-hint" && request.method === "DELETE")
        return Response.json(await this.clearComputerAttached());
      if (path === "/__test/computer-hint" && request.method === "GET")
        return Response.json({
          afterConfiguration: await this.ctx.storage.get("test:after-configuration"),
          afterInheritance: await this.ctx.storage.get("test:after-inheritance"),
        });
    }
    const response = await super.fetch(request);
    if (this.env.TEST_HOOKS === "1" && path === "/configuration" && request.method === "PUT" && response.ok)
      await this.ctx.storage.put("test:after-configuration", (await this.ctx.storage.get(COMPUTER_ATTACHED)) ?? null);
    return response;
  }
}
