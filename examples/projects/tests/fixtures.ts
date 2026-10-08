import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agents } from "@camelai/run";
import type { Files } from "../lib/versions.ts";

export const files = (entries: Record<string, string>): Files => new Map(Object.entries(entries).map(([path, text]) => [path, new TextEncoder().encode(text)]));

/**
 * Just enough of `Agents` for publish: volumes held in memory (volume id → files), and a data directory whose
 * registry already maps each project to its volume.
 */
export async function fakeRuntime(kind: string, projects: Record<string, Files>) {
  const dataDir = await mkdtemp(join(tmpdir(), "projects-"));
  const ids = Object.fromEntries(Object.keys(projects).map(project => [project, `vol_${project}`]));
  await writeFile(join(dataDir, `${kind}-volumes.json`), JSON.stringify(ids));
  const volumes = new Map(Object.entries(projects).map(([project, files]) => [ids[project], files]));
  const agents = {
    runtime: {
      volume: (id: string) => ({
        list: async () => ({ files: [...volumes.get(id)!].map(([path, data]) => ({ path, size: data.length })) }),
        read: async (path: string) => ({ data: volumes.get(id)!.get(path)! }),
      }),
    },
  } as unknown as Agents;
  return { agents, dataDir, volumes: (project: string) => volumes.get(ids[project])! };
}
