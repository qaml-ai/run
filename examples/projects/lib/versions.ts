import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A project's files: path (no leading slash) to bytes. */
export type Files = Map<string, Uint8Array>;

export interface Version {
  project: string;
  number: number;
  publishedAt: string;
  files: number;
  bytes: number;
  /** The publish call's idempotency key: a retried call gets this version back instead of a new one. */
  key: string;
}

/**
 * Published versions, on disk: `<root>/<project>/<n>/version.json` and the files under `<n>/files/`. A version is
 * written whole to a scratch directory and then renamed into place, so a reader never sees half of one, a version
 * never changes once it exists, and two publishes at once can't take the same number (the second rename fails).
 */
export class Versions {
  constructor(readonly root: string) {}

  async list(project: string): Promise<Version[]> {
    if (!/^[a-z0-9-]+$/.test(project)) return [];
    const names = await readdir(join(this.root, project)).catch(() => [] as string[]);
    const numbers = names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
    return Promise.all(numbers.map(async n => JSON.parse(await readFile(join(this.root, project, String(n), "version.json"), "utf8")) as Version));
  }

  /** A published file's bytes, or null. `path` comes from a URL: anything that could leave the version is refused. */
  async file(project: string, number: number, path: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!/^[a-z0-9-]+$/.test(project) || !safePath(path)) return null;
    return readFile(join(this.root, project, String(number), "files", path)).catch(() => null);
  }

  async publish(project: string, files: Files, key: string): Promise<Version> {
    const existing = (await this.list(project)).find(version => version.key === key);
    if (existing) return existing;
    const scratch = join(this.root, project, `.tmp-${crypto.randomUUID()}`);
    for (const [path, data] of files) {
      await mkdir(dirname(join(scratch, "files", path)), { recursive: true });
      await writeFile(join(scratch, "files", path), data);
    }
    const bytes = [...files.values()].reduce((sum, data) => sum + data.length, 0);
    for (let number = (await this.list(project)).length + 1; ; number++) {
      const version: Version = { project, number, publishedAt: new Date().toISOString(), files: files.size, bytes, key };
      await writeFile(join(scratch, "version.json"), JSON.stringify(version, null, 2));
      try {
        await rename(scratch, join(this.root, project, String(number)));
        return version;
      } catch (error: any) {
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") { await rm(scratch, { recursive: true, force: true }); throw error; }
      }
    }
  }
}

/** A relative path that stays inside its directory: no `..`, no absolute paths, no empty or hidden segments. */
export function safePath(path: string): boolean {
  const parts = path.split("/");
  return path.length > 0 && path.length <= 200 && parts.every(part => part !== "" && !part.startsWith(".") && !part.includes("\\"));
}
