import { basename, resolve } from "node:path";

/**
 * A node:test reporter that writes each test file's wall time, in seconds, as JSON:
 * { "agents.test.ts": 23.4, ... }. The runner reports every file as a top-level test named by its path
 * as it was given (tests/agents.test.ts), whose duration runs from its process starting to its
 * last test ending. scripts/test-shard.ts runs it beside the visible reporter, and `test-shard.ts --update`
 * folds what CI recorded into tests/timings.json.
 */
export default async function* timings(source: AsyncIterable<{ type: string; data: { name?: string; file?: string; nesting?: number; details?: { duration_ms?: number } } }>) {
  const seconds: Record<string, number> = {};
  for await (const event of source) {
    const { name, file, nesting, details } = event.data ?? {};
    if (event.type === "test:complete" && nesting === 0 && file && name && resolve(name) === file && details?.duration_ms !== undefined) {
      seconds[basename(file)] = Math.round(details.duration_ms / 100) / 10;
    }
  }
  yield `${JSON.stringify(seconds, null, 2)}\n`;
}
