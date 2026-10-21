import { readFile } from "node:fs/promises";

/** The visible cgroup includes native workers and child processes, unlike Node's heap. */
export async function cgroupMemory(root = "/sys/fs/cgroup") {
  const number = async (path: string) => {
    try {
      const value = Number((await readFile(`${root}/${path}`, "utf8")).trim());
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch { return undefined; }
  };
  const v2 = await number("memory.current");
  const cgroupMemoryBytes = v2 ?? await number("memory/memory.usage_in_bytes");
  if (cgroupMemoryBytes === undefined) return {};
  const cgroupMemoryPeakBytes = await number(v2 !== undefined ? "memory.peak" : "memory/memory.max_usage_in_bytes");
  return { cgroupMemoryBytes, ...(cgroupMemoryPeakBytes !== undefined ? { cgroupMemoryPeakBytes } : {}) };
}
