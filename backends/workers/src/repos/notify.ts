import type { RepoContext } from './registry.ts';

/** Use the same disconnected prompt admission as other runtime deliveries. */
export async function notifyRepoWatchers(
  ctx: RepoContext,
  ref: string,
  result: { version: string | null; watchers: string[] },
  changes: Record<string, unknown>,
  author: string,
) {
  if (!result.watchers.length) return;
  const { Directory } = await import('../control.ts');
  for (const agent of result.watchers) {
    if (author === `agent:${agent}`) continue;
    try {
      const entry = await new Directory(ctx.env, ctx.tenant).get(agent);
      const mounts = (entry?.config.mounts ?? []).filter(
        mount => mount.repo === ctx.repoId && (mount.ref ?? 'main') === ref && mount.notify,
      );
      if (!mounts.length) {
        await ctx.repo.unwatch(ref, agent);
        continue;
      }
      const shown = Object.keys(changes).flatMap(path => mounts.flatMap(mount => {
        const base = (mount.subpath ?? '/').replace(/^\/+/, '');
        if (base && path !== base && !path.startsWith(base + '/')) return [];
        const relative = base ? path.slice(base.length).replace(/^\/+/, '') : path;
        return [`${mount.path}${relative ? '/' + relative : ''} (${changes[path] === null ? 'deleted' : 'written'})`];
      }));
      if (!shown.length) continue;
      const response = await ctx.env.AGENTS.getByName(agent).fetch(new Request('https://agent/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: `repo-${ctx.repoId}-${result.version}`,
          method: 'prompt',
          params: {
            text: `Files changed in a mounted volume:\n${shown.slice(0, 50).join('\n')}${shown.length > 50 ? `\n...and ${shown.length - 50} more` : ''}`,
            allowDisconnected: true,
          },
        }),
      }));
      if (response.status === 404 || response.status === 410) await ctx.repo.unwatch(ref, agent);
      else if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      // The commit already succeeded. Delivery failures must not turn it into a
      // failed write that the caller retries, or prevent other watchers waking.
      console.error('Repo watcher delivery failed', { repo: ctx.repoId, ref, agent, version: result.version });
    }
  }
}

/** Coalesce pending deliveries for each mount and submit through normal prompt admission. */
export async function deliverRepoMoves(env: RepoContext["env"], config: import("../agent-types.ts").Config, moves: import("../camelfs/notify.ts").RefMove[]) {
  const { repoContext } = await import("./registry.ts");
  for (const mount of config.config.mounts ?? []) {
    if (!mount.repo || !mount.notify) continue;
    const ctx = await repoContext(env, config.tenantId, mount.repo, `agent:${config.id}`);
    const matching = moves.filter(move => move.lineage === ctx.lineage && move.ref === (mount.ref ?? "main") && move.by !== ctx.sub)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    if (!matching.length) continue;
    const shown = new Map<string, string>();
    const base = (mount.subpath ?? "/").replace(/^\/+/, "");
    for (const move of matching) {
      const from = move.from ? await ctx.storage.getCommit(ctx.lineage, move.from) : null;
      const { changes } = await ctx.storage.diff(ctx.lineage, from?.tree ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904", move.tree);
      for (const { path, status } of changes) {
        if (base && path !== base && !path.startsWith(base + "/")) continue;
        const relative = base ? path.slice(base.length).replace(/^\/+/, "") : path;
        shown.set(path, `${mount.path}${relative ? "/" + relative : ""} (${status === "deleted" ? "deleted" : "written"})`);
      }
    }
    if (!shown.size) continue;
    const response = await env.AGENTS.getByName(config.id).fetch(new Request("https://agent/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `repo-${ctx.repoId}-${matching.at(-1)!.id}-${mount.path}`,
        method: "prompt",
        params: { text: `Files changed in a mounted volume:\n${[...shown.values()].slice(0, 50).join("\n")}`, allowDisconnected: true },
      }),
    }));
    if (!response.ok && response.status !== 410 && response.status !== 404) throw new Error(`Repo watcher delivery HTTP ${response.status}`);
  }
}
