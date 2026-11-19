import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { AgentRuntime, type Mount } from "../../clients/node.ts";
import { CamelRun, type V1HistoryImport } from "../sdk/src/index.ts";
import { readV1History } from "./migrate-history.ts";
import { migrateVolume } from "./migrate-volume.ts";

interface SourceAgent {
  url: string;
  apiKey: string;
  agentId: string;
}

interface StageOptions {
  initialCommit?: string;
  previous?: string;
  attachments?: V1HistoryImport["attachments"];
}

async function sourceState(source: SourceAgent): Promise<Mount[]> {
  const base = `/v1/agents/${encodeURIComponent(source.agentId)}`;
  async function get<T>(path: string): Promise<T> {
    const response = await fetch(new URL(base + path, source.url), {
      headers: { Authorization: `Bearer ${source.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`v1 ${path} returned HTTP ${response.status}`);
    return await response.json() as T;
  }
  const [state, pending, mounts] = await Promise.all([
    get<{ requests: { state: string }[] }>("/state"),
    get<unknown[]>("/inputs?state=pending"),
    get<Mount[]>("/mounts"),
  ]);
  if (state.requests.some(({ state }) => state === "running" || state === "queued") || pending.length) {
    throw new Error("The v1 agent has active work or pending input");
  }
  return mounts;
}

/** Prepare and verify data for an already configured private v2 agent. Routing belongs to the caller. */
export async function stageAgent(source: SourceAgent, v2: CamelRun, destination: string, options: StageOptions = {}) {
  const mounts = await sourceState(source);
  const mount = mounts[0];
  if (mounts.length > 1 || (mount && (mount.path !== "/workspace" || mount.subpath || mount.mode !== "rw"))) {
    throw new Error("Staging supports a single writable v1 volume mounted at /workspace");
  }
  const target = await v2.agents.get(destination);
  if (target.summary.activeRunId || target.summary.lastRun) throw new Error("The v2 destination already has activity");
  const history = await readV1History(source.url, source.apiKey, source.agentId);
  const input = { ...history, previous: options.previous, attachments: options.attachments };

  async function copyWorkspace() {
    if (!mount) {
      if (options.initialCommit) throw new Error("The v1 agent has no workspace volume");
      return null;
    }
    const { repoId, branch } = target;
    if (!repoId || !options.initialCommit) {
      throw new Error("A mounted v1 workspace requires a v2 repo and its initial commit");
    }
    const { defaultRef } = await v2.repos.get(repoId);
    if ((branch ?? defaultRef) !== defaultRef) throw new Error("The v2 agent must use the repository's default branch");
    const v1 = new AgentRuntime({ url: source.url, apiKey: source.apiKey });
    const volume = v1.volume(mount.volumeId);
    const copy = await migrateVolume(volume, v2, repoId, options.initialCommit);
    return { copy, volume };
  }

  const workspace = await copyWorkspace();
  const imported = await target.importV1History(input);
  if (!imported.receipt || imported.count !== history.messages.length) throw new Error("Incomplete v2 history receipt");

  try {
    for (let after = 0;;) {
      const page = await target.history({ after, limit: 50 });
      for (const entry of page) {
        if (entry.seq !== after + 1 || after >= history.messages.length ||
            !isDeepStrictEqual((entry.content as { meta?: { v1?: unknown } }).meta?.v1, history.messages[after])) {
          throw new Error(`v2 history differs from v1 at message ${after}`);
        }
        after++;
      }
      if (page.length < 50) {
        if (after !== history.messages.length) throw new Error("The v2 history is incomplete");
        break;
      }
    }

    const [currentMounts, latest] = await Promise.all([
      sourceState(source),
      readV1History(source.url, source.apiKey, source.agentId),
    ]);
    if (!isDeepStrictEqual(currentMounts, mounts) || !isDeepStrictEqual(latest.messages, history.messages) ||
        (workspace && (await workspace.volume.info()).seq !== workspace.copy.seq)) {
      throw new Error("The v1 agent changed during staging");
    }
    if (workspace) {
      const { copy, volume } = workspace;
      const [snapshots, repo] = await Promise.all([volume.snapshots(), v2.repos.get(copy.repoId)]);
      if (snapshots.length !== Object.keys(copy.snapshotCommits).length ||
          snapshots.some(snapshot => !Object.hasOwn(copy.snapshotCommits, snapshot.id)) || repo.commit !== copy.head) {
        throw new Error("The workspace changed during staging");
      }
    }
  } catch (error) {
    throw new Error(`Staging verification failed: ${String(error)}. The v2 history was written with receipt ${imported.receipt}.`, { cause: error });
  }
  return { source: source.agentId, destination: target.id, history: imported, workspace: workspace?.copy ?? null };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "initial-commit": { type: "string" }, previous: { type: "string" }, attachments: { type: "string" } },
  });
  const [source, destination, ...extra] = positionals;
  if (!source || !destination || extra.length) {
    throw new Error("Usage: node --experimental-strip-types v2/scripts/stage-agent.ts <v1-agent> <v2-agent> [--initial-commit sha] [--previous receipt] [--attachments manifest.json]");
  }
  const v2 = new CamelRun({ baseUrl: env("V2_URL"), apiKey: env("V2_API_KEY") });
  try {
    const attachments: V1HistoryImport["attachments"] = values.attachments
      ? JSON.parse(await readFile(values.attachments, "utf8"))
      : undefined;
    console.log(JSON.stringify(await stageAgent({ url: env("V1_URL"), apiKey: env("V1_API_KEY"), agentId: source }, v2,
      destination, { initialCommit: values["initial-commit"], previous: values.previous, attachments })));
  } finally {
    await v2.close();
  }
}
