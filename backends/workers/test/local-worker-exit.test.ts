import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { observeWorkerExit } from "./local-worker-exit.ts";

test("Worker startup diagnostics wait for stderr to close after process exit", async () => {
  const child = new EventEmitter() as ChildProcess;
  const stderr = new PassThrough();
  let output = "", settled = false;
  stderr.on("data", chunk => { output += chunk; });
  const exited = observeWorkerExit(child, () => output).then(error => { settled = true; return error; });
  child.emit("exit", 17, null);
  stderr.end("late startup failure\n");
  await Promise.resolve();
  assert.equal(settled, false, "exit does not mean the child output is drained");
  child.emit("close", 17, null);
  assert.equal((await exited).message, "workerd exited (code=17, signal=none): late startup failure\n");
});

test("Worker startup diagnostics preserve termination signals", async () => {
  const child = new EventEmitter() as ChildProcess;
  const exited = observeWorkerExit(child, () => "");
  child.emit("exit", null, "SIGTRAP");
  child.emit("close", null, "SIGTRAP");
  assert.equal((await exited).message, "workerd exited (code=null, signal=SIGTRAP): ");
});

test("Worker startup diagnostics preserve spawn errors without an unhandled error event", async () => {
  const child = new EventEmitter() as ChildProcess;
  const exited = observeWorkerExit(child, () => "");
  const failure = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
  child.emit("error", failure);
  child.emit("close", -2, null);
  const error = await exited;
  assert.equal(error.cause, failure);
  assert.match(error.message, /code=-2, signal=none; spawn node ENOENT/);
});
