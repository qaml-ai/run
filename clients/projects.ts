/**
 * Projects: an agent builds something in a volume of its own (a bot, a site, a report), and your application publishes
 * checked versions of it. A project is a volume made once per key, mounted in the agent with file tools, and a publish
 * step: snapshot the volume, read every file at that snapshot, check them with your code, and store them where your
 * application keeps what it serves. The snapshot is the version: what was checked is exactly what was stored.
 *
 * ```ts
 * const project = await agents.runtime.projects.create({ key: `bot-${bot.id}`, template: { "bot.ts": starter } });
 * const builder = await agents.upsert(`builder-${bot.id}`, { definition, subject: owner, context: { bot: bot.id }, ...project.mount("/bot") });
 * // In your MCP server: the model calls publish; the project comes from the call's signed identity, never its arguments.
 * serveTools({ publish: publishTool({ project: identity => projects.get(volumeOf(identity.context.bot)), validate, store }) }, options);
 * ```
 */
import type { AgentRuntime, MountInput, RuntimeIdentity, Tool, VolumeContents, VolumeHandle, VolumeSnapshot } from "./typescript.ts";

/** A file as a project version has it: text as `text`, other bytes as base64 `data`. */
export type ProjectFile = VolumeContents["files"][number];
/** A published version: the snapshot its files were read from. */
export interface ProjectVersion { id: string; seq: number; name: string; createdAt: number; pinned: boolean; labels: Record<string, string> }
/** What stops files from being published: shown to the model as `path:line: message`. */
export interface Problem { path?: string; line?: number; message: string }
/** What a check found: its problems, and what it worked out on the way (a manifest, a bundle) for `store`. */
export interface Checked<D> { problems?: Problem[]; data: D }
export type PublishResult<T, D = undefined> = { ok: true; version: ProjectVersion; stored: T; checked?: D } | { ok: false; problems: Problem[] };
export interface PublishOptions<T, D = undefined> {
  /** Only the files at or under this path (default: all). */
  prefix?: string;
  /**
   * What is wrong with the files: an empty list publishes them. Or `{ problems, data }`: `data` (what the check
   * computed, such as a bundle's manifest) goes to `store` as `checked` and comes back in the result, so nothing is
   * worked out twice.
   */
  validate?: (files: ProjectFile[]) => Problem[] | Checked<D> | Promise<Problem[] | Checked<D>>;
  /**
   * Keep the files (in your database, your object store): called once per published version, with the project and,
   * from `publishTool`, the identity of the call that published it.
   */
  store: (files: ProjectFile[], version: ProjectVersion, about: { project: Project; identity?: RuntimeIdentity; checked?: D }) => T | Promise<T>;
  /** How many published versions the project keeps (older snapshots are deleted; default 20, at most 90). Pinned versions are kept besides. */
  keep?: number;
  /** Pin this version: kept until unpinned, whatever `keep` says (a release your application runs, say). */
  pin?: boolean;
  /** Labels for this version, e.g. `{ release: "v12" }`. */
  labels?: Record<string, string>;
  /** Publishing twice with the same key publishes once: a retried tool call passes its `idempotencyKey`. */
  idempotencyKey?: string;
}

const PUBLISHED = "published:";
const versionOf = ({ id, seq, name, createdAt, pinned, labels }: VolumeSnapshot): ProjectVersion => ({ id, seq, name, createdAt, pinned, labels });
/** A file's contents as bytes, whichever way it came. */
export function fileBytes(file: ProjectFile): Uint8Array {
  return file.text !== undefined ? new TextEncoder().encode(file.text) : Uint8Array.from(atob(file.data ?? ""), char => char.charCodeAt(0));
}
/** Problems as the model reads them, one a line. */
export function formatProblems(problems: Problem[]): string {
  return problems.map(problem => `${problem.path ? `${problem.path}${problem.line ? `:${problem.line}` : ""}: ` : ""}${problem.message}`).join("\n");
}

/** A check's answer, whichever form it took. */
async function check<D>(validate: PublishOptions<unknown, D>["validate"], files: ProjectFile[]): Promise<{ problems: Problem[]; checked?: D }> {
  const answer = await validate?.(files);
  if (!answer) return { problems: [] };
  return Array.isArray(answer) ? { problems: answer } : { problems: answer.problems ?? [], checked: answer.data };
}

export class Project {
  readonly id: string;
  readonly volume: VolumeHandle;
  constructor(volume: VolumeHandle) { this.id = volume.id; this.volume = volume; }

  /**
   * What to give an agent so it works in the project: the volume at `path` (read-write, the first mount, so relative
   * paths are the project's), its own workspace beside it (for uploads, tool outputs and scratch), and file tools.
   * Spread it into `agents.upsert` (with `remount: true` to move an existing agent onto it).
   */
  mount(path = "/project"): { mounts: MountInput[]; fileTools: true } {
    return { mounts: [{ volumeId: this.id, path, mode: "rw" }, { workspace: true }], fileTools: true };
  }

  /** The files as they are now (one read at one seq), or as a version has them. */
  files(options: { prefix?: string; version?: string } = {}): Promise<VolumeContents> {
    return this.volume.readAll({ ...(options.prefix ? { prefix: options.prefix } : {}), ...(options.version ? { snapshot: options.version } : {}) });
  }

  /**
   * Put the project back as a published version had it, in place: the agent working in it sees the files change, as
   * if it had made them. The version stays published; publish again to make the restored files a new one.
   */
  restore(version: string) { return this.volume.restore(version); }

  /** A version's files (or the project as it is now) as a tar.gz stream, for a build. */
  archive(options: { version?: string; path?: string } = {}) {
    return this.volume.archive({ ...(options.version ? { snapshot: options.version } : {}), ...(options.path ? { path: options.path } : {}) });
  }

  /** Published versions, oldest first; with `labels`, only those that have every one. */
  async versions(options: { labels?: Record<string, string> } = {}): Promise<ProjectVersion[]> {
    return (await this.volume.snapshots(options)).filter(snapshot => snapshot.name.startsWith(PUBLISHED)).map(versionOf);
  }

  /** Keep a version until it is unpinned, past `keep`; `labels` replace its labels. */
  async pin(version: string, labels?: Record<string, string>): Promise<ProjectVersion> {
    return versionOf(await this.volume.updateSnapshot(version, { pinned: true, ...(labels ? { labels } : {}) }));
  }

  /** Let a version go with the others once it is older than `keep`. */
  async unpin(version: string): Promise<ProjectVersion> {
    return versionOf(await this.volume.updateSnapshot(version, { pinned: false }));
  }

  /**
   * Snapshot the project, read every file at the snapshot, `validate` them, and `store` them: `{ ok: true, version }`,
   * or `{ ok: false, problems }` (the snapshot is then deleted). Files written while it runs are not in this version.
   */
  async publish<T, D = undefined>(options: PublishOptions<T, D>, about: { identity?: RuntimeIdentity } = {}): Promise<PublishResult<T, D>> {
    const keep = Math.min(Math.max(1, options.keep ?? 20), 90);
    const name = `${PUBLISHED}${options.idempotencyKey ?? crypto.randomUUID()}`.slice(0, 120);
    if (options.idempotencyKey) {
      const done = (await this.versions()).find(version => version.name === name);
      if (done) {
        // Published already (a retried call): its files are checked again only for what the check hands on.
        const { files } = await this.files({ prefix: options.prefix, version: done.id });
        const { checked } = await check(options.validate, files);
        const stored = await options.store(files, done, { project: this, ...about, ...(checked !== undefined ? { checked } : {}) });
        return { ok: true, version: done, stored, ...(checked !== undefined ? { checked } : {}) };
      }
    }
    const snapshot = await this.volume.snapshot({ name, ...(options.pin ? { pinned: true } : {}), ...(options.labels ? { labels: options.labels } : {}) });
    const version = versionOf(snapshot);
    try {
      const { files } = await this.files({ prefix: options.prefix, version: version.id });
      const { problems, checked } = await check(options.validate, files);
      if (problems.length) {
        await this.volume.deleteSnapshot(version.id);
        return { ok: false, problems };
      }
      const stored = await options.store(files, version, { project: this, ...about, ...(checked !== undefined ? { checked } : {}) });
      // Older versions beyond `keep` go (a volume keeps 100 snapshots at most).
      // Pinned versions stay, and do not count against `keep`.
      const versions = (await this.versions()).filter(old => !old.pinned);
      await Promise.all(versions.slice(0, Math.max(0, versions.length - keep)).map(old => this.volume.deleteSnapshot(old.id)));
      return { ok: true, version, stored, ...(checked !== undefined ? { checked } : {}) };
    } catch (error) {
      await this.volume.deleteSnapshot(version.id).catch(() => {});
      throw error;
    }
  }
}

export class Projects {
  private readonly runtime: AgentRuntime;
  constructor(runtime: AgentRuntime) { this.runtime = runtime; }

  /**
   * The project for `key`: its volume is made the first time (and seeded with `template`, path to contents), and is the
   * same one every time after, for as long as it lives. A project with no files is seeded again, so a create cut off
   * mid-way finishes on its retry; files already there are never overwritten.
   */
  async create(options: { key: string; name?: string; template?: Record<string, string | Uint8Array> }): Promise<Project> {
    const made = await this.runtime.createVolume({ name: options.name ?? options.key.slice(0, 120), key: options.key });
    const project = this.get(made.id);
    if (options.template && (!made.existing || made.files === 0)) {
      await Promise.all(Object.entries(options.template).map(([path, content]) =>
        project.volume.write(path, content, { version: 0 }).catch((error: { status?: number }) => { if (error.status !== 412) throw error; })));
    }
    return project;
  }

  /** A project by its volume's id. */
  get(id: string): Project { return new Project(this.runtime.volume(id)); }
}

/**
 * A `publish` tool for your MCP server (`serveTools`): the model calls it when its work is ready. The project comes
 * from the call's signed identity (`project(identity)`), never from the model's arguments, which carry nothing; the
 * files are read server-side from a snapshot, so the model cannot hand you content it did not write to the project.
 * Problems go back to the model (the call fails with them) so it fixes them and publishes again. A retried call
 * publishes once.
 */
export function publishTool<T, D = undefined>(options: Omit<PublishOptions<T, D>, "idempotencyKey"> & {
  /** The project the call is for, from its identity. An agent whose project changes (remounted) is looked up as it is now. */
  project: (identity: RuntimeIdentity) => Project | Promise<Project>;
  description?: string;
  /** What the model is told on success (default: the version id); `checked` is what `validate` handed on. */
  published?: (result: { version: ProjectVersion; stored: T; checked?: D }) => unknown;
}): Tool {
  return {
    description: options.description ?? "Publish the project: its files are checked, and if nothing is wrong they become the new version. If anything is wrong, the call fails with what to fix; fix it and publish again.",
    exposure: "direct",
    executionMode: "sequential",
    input: { type: "object", properties: {}, additionalProperties: false },
    async execute(_args, context) {
      if (!context.identity) throw new Error("publish needs the runtime's identity token: serve it with serveTools and auth { type: \"runtime\" }");
      const project = await options.project(context.identity);
      // A key that is only this request's JSON-RPC id (a client that sends none) is no key: unrelated calls share ids.
      const keyed = context.idempotencyKey !== context.callId;
      const result = await project.publish({ ...options, ...(keyed ? { idempotencyKey: context.idempotencyKey } : {}) }, { identity: context.identity });
      if (!result.ok) throw new Error(`Not published. Fix these and publish again:\n${formatProblems(result.problems)}`);
      return options.published ? options.published(result) : { published: true, version: result.version.id };
    },
  };
}
