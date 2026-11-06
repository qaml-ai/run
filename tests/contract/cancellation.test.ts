import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { LocalWorker } from "../../backends/workers/test/local-worker.ts";

async function running(pid: number) {
  try { process.kill(pid, 0); } catch { return false; }
  // A reparented zombie has already stopped. Linux PID 1 may reap it later.
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return !/^\d+ \(.*\) Z /.test(stat);
}

test("LocalWorker cancellation during port allocation prevents a late spawn", async () => {
  const worker = new LocalWorker(1, "/tmp/unused-contract-worker");
  const starting = worker.start();
  await worker.stop();
  await assert.rejects(starting, /startup was cancelled/);
});

test("a Workers fixture abort stops a pending worker start before startup settles", async () => {
  const moduleUrl = new URL("../../backends/workers/test/fixture.ts", import.meta.url).href;
  const { startFixture } = await import(moduleUrl);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const originalStart = LocalWorker.prototype.start;
  const originalStop = LocalWorker.prototype.stop;
  let stopped = false;
  LocalWorker.prototype.start = async function() { entered.resolve(); await release.promise; };
  LocalWorker.prototype.stop = async function(hard) { stopped = true; await originalStop.call(this, hard); };
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  const starting = startFixture({ signal: controller.signal }).then((value: Awaited<ReturnType<typeof startFixture>>) => { fixture = value; return value; });
  try {
    await Promise.race([entered.promise, starting.then(() => { throw new Error("fixture started before its worker barrier"); })]);
    controller.abort();
    assert.equal(stopped, true, "abort stops the owned worker before waiting for startup");
    release.resolve();
    await assert.rejects(starting, /startup was cancelled/);
  } finally {
    release.resolve();
    await starting.catch(() => {});
    await fixture?.stop();
    LocalWorker.prototype.start = originalStart;
    LocalWorker.prototype.stop = originalStop;
  }
});

test("LocalWorker stops its detached descendants after the parent exits, leaving other groups alone", { timeout: 12_000 }, async t => {
  const owned: ChildProcess[] = [];
  t.after(() => {
    for (const child of owned) try { process.kill(-child.pid!, "SIGKILL"); } catch {}
  });
  const source = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',data=>{process.stdout.write(data); child.unref(); child.stdout.destroy(); setTimeout(()=>process.exit(0),10)});`;
  const parent = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  owned.push(parent);
  const [output] = await once(parent.stdout!, "data");
  const descendant = Number(String(output).trim());
  assert.ok(Number.isInteger(descendant) && descendant > 1);
  if (parent.exitCode === null) await once(parent, "exit");
  const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  owned.push(sibling);
  const worker = new LocalWorker(1, "/tmp/unused-contract-worker");
  Object.assign(worker, { child: parent });
  assert.equal(await running(descendant), true);
  await worker.stop();
  assert.equal(await running(descendant), false);
  assert.equal(await running(sibling.pid!), true);
});
