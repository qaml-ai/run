import { basename } from "node:path";

/**
 * A node:test reporter that writes the test files with a failure, one name a line (agents.test.ts). A file's
 * failures are its top-level tests' and its own (a crash, or the file timing out). scripts/test-shard.ts runs it beside
 * the visible reporter to rerun those files once.
 */
export default async function* failures(source: AsyncIterable<{ type: string; data: { file?: string; nesting?: number } }>) {
  const failed = new Set<string>();
  for await (const event of source) {
    const { file, nesting } = event.data ?? {};
    // A top-level failure no file is named for is written as `*`: test-shard.ts then retries nothing, so a failure it
    // cannot attribute is never passed by retrying other files.
    if (event.type === "test:fail" && nesting === 0) failed.add(file ? basename(file) : "*");
  }
  yield [...failed].map(file => `${file}\n`).join("");
}
