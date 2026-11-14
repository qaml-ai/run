import { AgentInvocation } from "./agent-invocation.ts";
import { StorageError } from "./repos/storage.ts";
import { WORKFLOW_COMMIT_PREFIX } from "./workflow-forks.ts";
export { WORKFLOW_COMMIT_PREFIX };
import { repoContext, type RepoEnv } from "./repos/registry.ts";
import { mergeRefs } from "./repos/merge.ts";
import { repoErrorFrom } from "./repos/repo-policy.ts";
import type { WorkflowFork } from "./workflow-branches.ts";
import type { EffectExecutor, EffectOutcome, StartedEffect } from "./workflow-runner.ts";


interface WorkflowCommitsHost {
  tenant(): string;
  storage: Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;
  land(key: string, attempt: number, outcome: EffectOutcome): Promise<void>;
  waitUntil(promise: Promise<void>): void;
}

/** Run merges in the background so land() can enter the runner's queue. */
export class WorkflowCommits implements EffectExecutor {
  private readonly running = new Set<string>();

  private readonly env: RepoEnv;
  private readonly host: WorkflowCommitsHost;

  constructor(env: RepoEnv, host: WorkflowCommitsHost) {
    this.env = env;
    this.host = host;
  }

  async start(effect: StartedEffect) {
    const name = this.row(effect);
    await this.host.storage.put(name, effect);
    this.launch(name, effect);
  }

  async recover() {
    for (const [name, effect] of await this.host.storage.list<StartedEffect>({ prefix: WORKFLOW_COMMIT_PREFIX }))
      this.launch(name, effect);
  }

  async poll(effect: StartedEffect) {
    const name = this.row(effect);
    const saved = await this.host.storage.get<StartedEffect>(name);
    if (saved) this.launch(name, saved);
    return undefined;
  }

  private row(effect: StartedEffect) {
    return WORKFLOW_COMMIT_PREFIX + JSON.stringify([effect.key, effect.attempt]);
  }

  private launch(name: string, effect: StartedEffect) {
    if (this.running.has(name)) return;
    this.running.add(name);
    this.host.waitUntil(this.run(name, effect)
      .catch(error => console.error(JSON.stringify({ type: "workflow_commit_failed", key: effect.key, error: error instanceof Error ? error.message.slice(0, 300) : "Error" })))
      .finally(() => { this.running.delete(name); }));
  }

  private async run(name: string, effect: StartedEffect) {
    const outcome = await this.commit(effect.args as { fork?: unknown; snapshot?: unknown });
    await this.host.land(effect.key, effect.attempt, outcome);
    await this.host.storage.delete(name);
  }

  /** commit(fork): the fork's edits onto its base, or the conflicts. Storage down throws: its row stays, a restart tries again. */
  private async commit(args: { fork?: unknown; snapshot?: unknown }): Promise<EffectOutcome> {
    try {
      if ('snapshot' in args) throw Object.assign(new Error('commit() has no snapshot option'), { status: 400 });
      const fork = args.fork as WorkflowFork;
      if (!fork || typeof fork !== 'object' || typeof fork.repo !== 'string' || typeof fork.ref !== 'string' || !fork.base)
        throw Object.assign(new Error('commit() needs { fork: { repo, ref, base } }'), { status: 400 });
      if (!fork.base.ref) return { ok: false, error: 'A fork of a version has no branch to merge into; start the agent from a ref to commit its changes' };
      const ctx = await repoContext(this.env, this.host.tenant(), fork.repo);
      try {
        const merged = await mergeRefs(ctx, { into: fork.base.ref, from: fork.ref }, new AgentInvocation());
        return { ok: true, value: { committed: true, version: merged.version, changed: merged.changed, ...('files' in merged ? { files: Object.keys(merged.files) } : {}) } };
      } catch (error) {
        const found = repoErrorFrom(error);
        if (found?.code === 'conflicts') return { ok: true, value: { committed: false, conflicts: found.detail?.conflicts } };
        throw error;
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const status = (error as { status?: number }).status;
      if (status === undefined || status >= 500) throw error;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
