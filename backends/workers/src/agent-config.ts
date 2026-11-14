import { refuseVolumeMounts } from './repos/mounts.ts';
import type { Config } from './agent-types.ts';
import type { AgentRuntime } from './agent-runtime.ts';

export async function configImpl(this: AgentRuntime) {
    if (await this.ctx.storage.get("deleted"))
      throw Object.assign(new Error("Agent deleted"), { status: 410 });
    const config = await this.ctx.storage.get<Config>("configuration");
    if (!config)
      throw Object.assign(new Error("Agent not found"), { status: 404 });
    refuseVolumeMounts(config.id, config.config.mounts);
    // Pi reads its queue modes synchronously (agent-tools.ts `settings`): an agent whose queue batches takes all at a boundary.
    this.batching = config.config.queue?.mode === "batch" && config.config.type !== "subagent";
    if (config.expiresAt && config.expiresAt <= Date.now())
      throw Object.assign(new Error("Agent expired"), { status: 410 });
    return config;
  }
