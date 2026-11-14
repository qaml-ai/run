import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const workerModule = new URL("./local-worker.ts", import.meta.url).href;
const fixtureModule = new URL("./fixture.ts", import.meta.url).href;
const workerSource = `
  import { writeFileSync } from "node:fs";
  import { createServer } from "node:http";
  const [mode, , , pidFile] = process.argv.slice(2);
  process.on("SIGTERM", () => {});
  console.error("worker boot marker");
  writeFileSync(pidFile, String(process.pid));
  const server = createServer((_req, res) => res.writeHead(204).end());
  server.listen(0, "127.0.0.1", () => {
    if (!mode.endsWith("startup-timeout")) process.send({ type: "workerd", port: server.address().port });
  });
`;

for (const mode of ["test-startup-timeout", "test-body-timeout", "worker-startup-timeout", "stop-escalation", "sequential-import"]) {
  test(mode, { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-worker-lifecycle-"));
    const entrypoint = join(directory, "worker.mjs");
    const pidFile = join(directory, "worker.pid");
    const pidFiles = mode === "sequential-import" ? [`${pidFile}-1`, `${pidFile}-2`] : [pidFile];
    const fixture = join(directory, "fixture.mjs");
    let harnessPid: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await writeFile(entrypoint, workerSource);
      await writeFile(fixture, `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import test from "node:test";
        const mode = ${JSON.stringify(mode)};
        const pidFile = ${JSON.stringify(pidFile)};
        const entrypoint = ${JSON.stringify(entrypoint)};
        const assertGroupGone = () => {
          const pid = Number(readFileSync(pidFile, "utf8"));
          assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
        };
        const keepTestAlive = t => {
          // Node's test timeout is itself unref'ed. Model a test with pending
          // work, then release that work when the timeout fires.
          const pending = setInterval(() => {}, 1000);
          t.after(() => clearInterval(pending));
        };
        if (mode === "sequential-import") {
          for (const index of [1, 2]) {
            test("fixture " + index, { timeout: 5000 }, async t => {
              const { startFixture } = await import(${JSON.stringify(fixtureModule)});
              assert.equal(typeof startFixture, "function");
              const { LocalWorker, unusedPort } = await import(${JSON.stringify(workerModule)});
              const worker = new LocalWorker(await unusedPort(), pidFile + "-" + index, mode, undefined, { entrypoint });
              await worker.start();
              t.after(() => worker.stop(true));
            });
          }
        } else test(mode, { timeout: mode.startsWith("test-") ? 1500 : 10000 }, async t => {
          keepTestAlive(t);
          const { LocalWorker, unusedPort } = await import(${JSON.stringify(workerModule)});
          const worker = new LocalWorker(await unusedPort(), pidFile, mode, undefined, {
            entrypoint,
            startupTimeoutMs: mode === "worker-startup-timeout" ? 1500 : 60000,
          });
          if (mode === "worker-startup-timeout") {
            await assert.rejects(worker.start(), /Local Worker did not start within 1500 ms: worker boot marker/);
            assertGroupGone();
            return;
          }
          await worker.start(t.signal);
          console.log("fixture ready");
          if (mode === "stop-escalation") {
            await worker.stop();
            assertGroupGone();
            return;
          }
          // Leave this worker running so the test exercises exit cleanup.
          await new Promise(() => {});
        });
      `);
      const harness = spawn(process.execPath, ["--experimental-strip-types", "--test", fixture], {
        detached: true,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      });
      harnessPid = harness.pid;
      let output = "";
      harness.stdout.on("data", chunk => { output += chunk; });
      harness.stderr.on("data", chunk => { output += chunk; });
      const [code, signal] = await Promise.race([
        once(harness, "close"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`node --test did not exit within 12 seconds:\n${output}`)), 12_000);
        }),
      ]);
      harnessPid = undefined;
      assert.equal(signal, null, output);
      assert.equal(code, mode.startsWith("test-") ? 1 : 0, output);
      if (mode.startsWith("test-")) assert.match(output, /testTimeoutFailure/, output);
      if (mode === "test-startup-timeout") assert.doesNotMatch(output, /fixture ready/);
      if (mode === "test-body-timeout") assert.match(output, /fixture ready/);
      if (mode === "sequential-import") assert.match(output, /# pass 2\b/);
      for (const file of pidFiles) {
        const pid = Number(await readFile(file, "utf8"));
        assert.ok(Number.isInteger(pid) && pid > 1);
        const deadline = Date.now() + 1000;
        for (;;) {
          // An orphaned zombie has stopped running even if PID 1 has yet to reap it.
          const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
          if (/^\d+ \(.*\) Z /.test(stat)) break;
          try {
            process.kill(-pid, 0);
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
            assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
            break;
          }
          assert.ok(Date.now() < deadline, `Worker process group ${pid} survived the test runner`);
          await sleep(20);
        }
      }
    } finally {
      clearTimeout(timer);
      if (harnessPid) try { process.kill(-harnessPid, "SIGKILL"); } catch {}
      for (const file of pidFiles) {
        const pid = Number(await readFile(file, "utf8").catch(() => ""));
        if (Number.isInteger(pid) && pid > 1) try { process.kill(-pid, "SIGKILL"); } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
