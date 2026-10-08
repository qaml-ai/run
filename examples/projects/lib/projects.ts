import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agents, schema, tool, type Agent, type AgentConfig, type RuntimeIdentity, type Tools } from "@camelai/run";
import { serveTools } from "@camelai/run/server";
import { safePath, type Files, type Version, type Versions } from "./versions.ts";

/** What a validator found wrong: the model reads these, fixes the files, and publishes again. */
export type Problem = { path?: string; message: string };
/** Checks a project's files: problems refuse the publish; otherwise the files to store (the same, or prepared). */
export type Validate = (files: Files) => Promise<{ problems: Problem[]; files?: Files }>;

const PROJECT_ID = /^[a-z0-9-]{1,40}$/;
/** What publish reads from a volume at most; each example's validator sets its own, tighter limits. */
const READ_LIMIT = { files: 1_000, bytes: 50 * 1024 * 1024 };

export interface ProjectsOptions {
  agents: Agents;
  /** "site", "dashboard": names the agents (`site-<project>`) and where the volume is mounted (`/site`). */
  kind: string;
  /** Where this app keeps its records (the volume of each project) and its published versions. */
  dataDir: string;
  versions: Versions;
  validate: Validate;
  /** The published version's address, for the model to hand to the user. */
  url: (project: string, version: number) => string;
  /** Agent configuration: instructions, model. */
  agent: Pick<AgentConfig, "instructions" | "model">;
  /**
   * Where camelRun reaches this app (https://…), to serve the tools over HTTP at `<publicUrl>/mcp` (`mcpHandler`):
   * the deployed shape. Without it the tools run in this process, attached to each agent, which needs no public URL.
   */
  publicUrl?: string;
}

/**
 * A project is a camelRun volume the agent builds in, with its own file tools, and the versions this app published
 * from it. The agent never writes a version: it calls `publish`, and the app reads the volume itself, checks the
 * files and keeps an immutable copy. Published versions are served by the app alone; camelRun is not involved.
 */
export class Projects {
  readonly options: ProjectsOptions;
  readonly tools: Tools;
  private lookups: Promise<unknown> = Promise.resolve();
  private definition?: Promise<string>;

  constructor(options: ProjectsOptions) {
    this.options = options;
    this.tools = { publish: this.publishTool() };
  }

  /** The project's agent, made on first use: it acts for `subject`, with the project's volume mounted read-write. */
  async open(project: string, subject = "local"): Promise<Agent> {
    if (!PROJECT_ID.test(project)) throw new Error("A project id is 1 to 40 lowercase letters, digits and dashes");
    const { agents, kind, agent, publicUrl } = this.options;
    const config: AgentConfig = {
      subject,
      // The tools read the project from here, where the model can't change it.
      context: { project },
      mounts: [{ volumeId: await this.volumeOf(project), path: `/${kind}`, mode: "rw" }],
    };
    // Served: the definition names this app's /mcp. Attached: this process answers the agent's tool calls.
    return publicUrl
      ? agents.upsert(`${kind}-${project}`, { ...config, definition: await this.definitionId() })
      : agents.upsert(`${kind}-${project}`, { ...config, ...agent, tools: this.tools });
  }

  /** The project's files as the agent left them, read with this app's API key. */
  async read(project: string): Promise<Files> {
    const volume = this.options.agents.runtime.volume(await this.volumeOf(project));
    const files: Files = new Map();
    let bytes = 0;
    for (let after: string | undefined; ;) {
      const page = await volume.list({ after, limit: 500 });
      for (const file of page.files) {
        const path = file.path.replace(/^\/+/, "");
        if (!safePath(path)) continue; // dotfiles and the like are the agent's scratch, never published
        bytes += file.size;
        if (files.size >= READ_LIMIT.files || bytes > READ_LIMIT.bytes) throw new Error(`The project is over ${READ_LIMIT.files} files or ${READ_LIMIT.bytes / 1024 / 1024} MB`);
        files.set(path, (await volume.read(path)).data);
      }
      if (!page.next) return files;
      after = page.next;
    }
  }

  /** The tools served over HTTP, for `<publicUrl>/mcp`: each call's identity token is checked against this tenant. */
  async mcpHandler(): Promise<(request: Request) => Promise<Response>> {
    const { agents, publicUrl } = this.options;
    if (!publicUrl) throw new Error("Set publicUrl to serve the tools over HTTP");
    const { tenant } = await agents.runtime.me();
    return serveTools(this.tools, { runtime: agents.runtime.options.url ?? "https://run.camelai.com", tenant, audience: `${publicUrl}/mcp` });
  }

  private publishTool() {
    const { versions, validate, url } = this.options;
    return tool({
      description: `Publish the files under /${this.options.kind} as a new version. Returns the version and its address, or the problems to fix first.`,
      input: schema.Object({}),
      timeoutMs: 60_000,
      execute: async (_args, { identity, idempotencyKey }) => {
        const project = projectOf(identity);
        const files = await this.read(project);
        const checked = await validate(files);
        if (checked.problems.length) return { published: false, problems: checked.problems };
        const version: Version = await versions.publish(project, checked.files ?? files, idempotencyKey);
        return { published: true, version: version.number, url: url(project, version.number) };
      },
    });
  }

  /**
   * project id → volume id, in a file: createVolume makes a new volume on each call, so the app remembers its own.
   * One lookup at a time, so two first calls for a project never make two volumes.
   */
  private volumeOf(project: string): Promise<string> {
    const { agents, dataDir, kind } = this.options;
    const file = join(dataDir, `${kind}-volumes.json`);
    const lookup = this.lookups.then(async () => {
      const volumes: Record<string, string> = await readFile(file, "utf8").then(JSON.parse, () => ({}));
      if (!volumes[project]) {
        volumes[project] = (await agents.runtime.createVolume({ name: `${kind} ${project}` })).id;
        await mkdir(dataDir, { recursive: true });
        await writeFile(file, JSON.stringify(volumes, null, 2));
      }
      return volumes[project];
    });
    this.lookups = lookup.catch(() => {});
    return lookup;
  }

  private definitionId(): Promise<string> {
    const { agents, kind, agent, publicUrl } = this.options;
    return this.definition ??= agents.runtime.upsertDefinition(`projects-${kind}`, {
      name: `${kind} builder`,
      ...(agent.instructions ? { systemPrompt: agent.instructions } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      mcpServers: [{ name: "app", url: `${publicUrl}/mcp`, auth: { type: "runtime" }, exposure: "direct" }],
    }).then(definition => definition.id);
  }
}

/** The project a call is for: the agent's context, set by this app with its API key. Never the model's arguments. */
export function projectOf(identity: RuntimeIdentity | undefined): string {
  const project = identity?.context?.project;
  if (typeof project !== "string" || !PROJECT_ID.test(project)) throw new Error("This agent has no project");
  return project;
}
