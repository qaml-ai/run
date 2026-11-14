import { sha256Hex } from './git.ts';
import type { RepoContext } from './registry.ts';

export async function repoMoveRequestId(repo: string, delivery: string, mount: string) {
  return 'repo-' + await sha256Hex(new TextEncoder().encode(JSON.stringify([repo, delivery, mount])));
}

/** Coalesce pending deliveries for each mount and submit through normal prompt admission. */
export async function deliverRepoMoves(env: RepoContext["env"], config: import("../agent-types.ts").Config, moves: import("../camelfs/notify.ts").RefMove[], admit: (request: Request) => Promise<Response>) {
  const { repoContext } = await import("./registry.ts");
  for (const mount of config.config.mounts ?? []) {
    if (!mount.repo || !mount.notify) continue;
    const row = await env.TENANTS.getByName(config.tenantId).repoRow(mount.repo);
    if (!row || row.deletedAt !== null || !moves.some(move => move.lineage === row.lineage)) continue;
    const ctx = await repoContext(env, config.tenantId, mount.repo, `agent:${config.id}`);
    const ref = ctx.repo.tierRefName(mount.ref ?? "main");
    const matching = moves.filter(move => move.lineage === ctx.lineage && move.ref === ref && move.by !== ctx.sub)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    if (!matching.length) continue;
    const shown = new Map<string, string>();
    const base = (mount.subpath ?? "/").replace(/^\/+/, "");
    // Walk backward from the current head. When the chain has a gap, use the
    // current ref and the oldest supplied base to report a net change.
    const head = await ctx.repo.ref(mount.ref ?? "main");
    if (!head) continue;
    const byVersion = new Map(matching.map(move => [move.to, move]));
    let first = byVersion.get(head.version);
    const visited = new Set<string>();
    while (first?.from && !visited.has(first.from) && byVersion.has(first.from)) {
      visited.add(first.to);
      first = byVersion.get(first.from);
    }
    first ??= matching[0];
    const from = first.from ? await ctx.storage.getCommit(ctx.lineage, first.from) : null;
    const { changes } = await ctx.storage.diff(ctx.lineage, from?.tree ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head.tree);
    for (const { path, status } of changes) {
      if (base && path !== base && !path.startsWith(base + "/")) continue;
      const relative = base ? path.slice(base.length).replace(/^\/+/, "") : path;
      shown.set(path, `${mount.path}${relative ? "/" + relative : ""} (${status === "deleted" ? "deleted" : "written"})`);
    }
    if (!shown.size) continue;
    const response = await admit(new Request("https://agent/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: await repoMoveRequestId(ctx.repoId, matching.at(-1)!.id, mount.path),
        method: "prompt",
        params: { text: `Files changed in a mounted volume:\n${[...shown.values()].slice(0, 50).join("\n")}`, allowDisconnected: true },
      }),
    }));
    if (!response.ok && response.status !== 410 && response.status !== 404) throw new Error(`Repo watcher delivery HTTP ${response.status}`);
  }
}
