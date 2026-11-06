// Node test reporter: appends one "<status>\t<file>\t<nesting>\t<name>" line per test to $TEST_STATUS_FILE, so two
// runs (different concurrency or shards) can be compared by sorting both files and diffing them. Usage:
//   TEST_STATUS_FILE=statuses.txt node --test --test-reporter=./scripts/test-status-reporter.mjs --test-reporter=spec ...
import { appendFileSync } from "node:fs";
import { relative } from "node:path";
export default async function* statusReporter(source) {
  const rows = [];
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { name, nesting, file, skip, todo } = event.data;
    const status = event.type === "test:fail" ? "fail" : skip ? "skip" : todo ? "todo" : "pass";
    rows.push(`${status}\t${file ? relative(process.cwd(), file) : "-"}\t${nesting}\t${name}`);
  }
  rows.sort();
  appendFileSync(process.env.TEST_STATUS_FILE, rows.join("\n") + "\n");
}
