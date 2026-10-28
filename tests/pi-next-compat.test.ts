import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommitPublication, Harness, ReportInfo, TaskId } from "@earendil-works/pi-durable";
import { observeCommits, piReport } from "../src/pi-durable/agent.ts";

// The Pi release after 1.4.0 changes these call shapes; camelRun takes both until it is installed.
test("Pi reports read the same in 1.4.0's (error, info) shape and the next release's (report) shape", () => {
  const error = new Error("disk gone");
  const task = { kind: "pi.generation", id: 7 as TaskId };
  assert.deepEqual(piReport(error, { type: "session_failed" } as ReportInfo), { kind: "session_failed", error });
  assert.deepEqual(piReport(error, { type: "task_parked", task } as ReportInfo), { kind: "task_parked", error, task });
  assert.deepEqual(piReport({ kind: "storage_failed", error }), { kind: "storage_failed", error });
  assert.deepEqual(piReport({ kind: "task_interrupted", error, task, reason: "interrupted" }), { kind: "task_interrupted", error, task, reason: "interrupted" });
  // An error that happens to carry a `kind` is still 1.4.0's first argument when info comes with it.
  const coded = Object.assign(new Error("x"), { kind: "odd" });
  assert.deepEqual(piReport(coded, { type: "listener_error" } as ReportInfo), { kind: "listener_error", error: coded });
});

test("stored commits are observed through subscribeCommits where the Harness has it (1.4.0), else observeCommits", () => {
  const publication = { seq: 1, changes: [] } as unknown as CommitPublication;
  const seen: CommitPublication[] = [];
  let subscribed: ((publication: CommitPublication) => void) | undefined;
  // 1.4.0's Harness also has an internal observeCommits(listener) of another shape: subscribeCommits wins.
  observeCommits({ observeCommits: () => { throw new Error("internal in 1.4.0"); }, subscribeCommits: (listener: (publication: CommitPublication) => void) => { subscribed = listener; return () => {}; } } as unknown as Harness, value => seen.push(value));
  subscribed!(publication);
  let observer: { advance(publication: CommitPublication, context: unknown): void; end(end: unknown): void } | undefined;
  observeCommits({ observeCommits: (value: typeof observer) => { observer = value; return { detach() {} }; } } as unknown as Harness, value => seen.push(value));
  observer!.advance(publication, {});
  observer!.end({ kind: "ended" });
  assert.deepEqual(seen, [publication, publication]);
});
