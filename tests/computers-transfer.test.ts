import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Computers } from "../src/computers/service.ts";
import { ComputerTransfers, TRANSFER_PATH } from "../src/computers/transfers.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Outbound } from "../src/outbound.ts";
import { VolumeService, VOLUME_LIMITS, type Mount } from "../src/volumes.ts";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { api } from "../src/api.ts";
import { testDatabase } from "./database.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);
type Context = { after(fn: () => Promise<void> | void): void };
async function fixture(t: Context) {
  const { db } = await testDatabase();
  await db.query("insert into agents(id,tenant,header,revision,name,type,model) values ('a','alice','{}',1,'A','test','x')");
  let quota: { used: number; limit: number } | undefined;
  const volumes = new VolumeService({ db, storage: memoryStorage(postgresTail(db, { unfenced: true })), quota: async () => quota });
  t.after(() => volumes.close());
  const { id } = await volumes.create("alice");
  const mounts: Mount[] = [{ volumeId: id, path: "/workspace", mode: "rw" }];
  let now = Date.now(), calls = 0;
  const transfers = new ComputerTransfers({ db, volumes, publicUrl: () => "https://runtime.example", now: () => now });
  const app = api({ transfers } as any);
  const directory = await mkdtemp(join(tmpdir(), "computer-transfer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: Request[] = [];
  let intercept: ((request: Request) => Promise<void>) | undefined;
  let fail = false;
  const accounts = new Accounts({ db, tenants: new Tenants({ read: async () => '{"tenants":{}}' }), secretsKey: "ab".repeat(32) });
  const service = new Computers({ db, accounts, outbound: new Outbound(), transfers, now: () => now, driver: () => ({
    async create(id) { return { id }; }, async close() {},
    async call(_ref, operation, args) {
      calls++;
      assert.equal(operation, "computer_exec");
      // Execute the real shell command, substituting curl with an argv capture. The fake then
      // streams files through the real API handler, without a socket or provider network.
      const result = await exec("bash", ["-c", 'curl() { printf "%s\\0" "$@"; }; ' + args.command], { cwd: directory, encoding: "buffer" });
      const argv = result.stdout.toString().split("\0").filter(Boolean);
      assert.ok(argv.includes("--fail"));
      assert.ok(argv.includes("--globoff"));
      assert.ok(argv.includes("--max-time"));
      assert.equal(argv[argv.indexOf("--max-filesize") + 1], String(VOLUME_LIMITS.fileBytes));
      const url = argv.at(-1)!;
      if (fail) throw new Error(`provider failed: ${url}`);
      const upload = argv.includes("--upload-file");
      const path = argv[argv.indexOf(upload ? "--upload-file" : "--output") + 1];
      const bytes = upload ? await readFile(join(directory, path)) : undefined;
      const request = new Request(url, { method: upload ? "PUT" : "GET", ...(bytes ? { body: bytes } : {}) });
      requests.push(request);
      await intercept?.(request);
      const response = await app.fetch(request);
      if (!response.ok) return { exitCode: 22, stderr: `curl ${url}: HTTP ${response.status}` };
      if (!upload) await writeFile(join(directory, path), Buffer.from(await response.arrayBuffer()));
      return { exitCode: 0, stdout: `untrusted output ${url}`, stderr: `untrusted error ${url}` };
    },
  }) });
  await service.create("alice", { agent: "a", provider: "sprites", credentials: { apiKey: "fake" }, leaseSeconds: 900, dailySeconds: 900 });
  await service.call("alice", "a", "computer_start", {}, "start");
  let key = 0;
  const writes: unknown[] = [];
  return { db, volumes, id, mounts, directory, app, requests, transfers,
    call: (name: string, from: string, to: string, requestKey = String(++key)) => service.call("alice", "a", name, { from, to }, requestKey, { mounts, onWrite: file => writes.push(file) }),
    writes, calls: () => calls, advance: (ms: number) => now += ms,
    intercept: (fn: typeof intercept) => intercept = fn, fail: () => fail = true,
    quota: (value: typeof quota) => quota = value,
    read: async (path: string) => { const entry = await volumes.call(id, "alice", "stat", { path }); return volumes.readRange("alice", entry, 0, entry.size); },
  };
}

test("computer transfers round trip binary files, safely quote paths, attribute writes and replay receipts", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 42, 13, 10, 128]);
  await f.volumes.put("alice", f.id, "/source.bin", bytes);
  const remote = "dir with spaces/file [1-2] {a,b} ' $(touch injected).bin";
  const sent = await f.call("computer_upload", "source.bin", remote, "upload");
  assert.deepEqual(sent, { path: remote, size: bytes.length, sha256: sha256(bytes) });
  assert.deepEqual(await readFile(join(f.directory, remote)), bytes);
  await assert.rejects(readFile(join(f.directory, "injected")), /ENOENT/);
  const received = await f.call("computer_download", remote, "copy.bin", "download");
  assert.deepEqual(received, { path: "/workspace/copy.bin", size: bytes.length, sha256: sha256(bytes) });
  assert.deepEqual(await f.read("/copy.bin"), bytes);
  assert.equal((await f.volumes.call(f.id, "alice", "stat", { path: "/copy.bin" })).by, "a");
  assert.equal(f.writes.length, 1);
  assert.deepEqual(await f.call("computer_download", remote, "copy.bin", "download"), received);
  assert.equal(f.calls(), 2);
  const records = (await f.db.query("select result from computer_commands")).rows;
  assert.doesNotMatch(JSON.stringify(records), /runtime\.example|token=|untrusted/);
  assert.equal((await f.db.query("select * from computer_transfers")).rowCount, 0);
});

test("capabilities store only hashes, reject another direction and path, and consume atomically", async t => {
  const f = await fixture(t);
  await f.volumes.put("alice", f.id, "/source", Buffer.from("hello"));
  f.intercept(async request => {
    const token = new URL(request.url).searchParams.get("token")!;
    const row = (await f.db.query("select * from computer_transfers")).rows[0];
    assert.equal(row.token_hash, sha256(Buffer.from(token)));
    assert.doesNotMatch(JSON.stringify(row), new RegExp(token));
    assert.equal(row.tenant, "alice"); assert.equal(row.agent, "a");
    assert.equal(row.volume, f.id); assert.equal(row.path, "/source");
    assert.equal((await f.app.fetch(new Request(request.url, { method: "PUT", body: "overwrite" }))).status, 403);
    assert.equal((await f.app.fetch(new Request(request.url.replace(TRANSFER_PATH, TRANSFER_PATH + "/other")))).status, 401);
    assert.equal((await f.app.fetch(new Request(request.url.replace(token, "0".repeat(64))))).status, 403);
    const [first, second] = await Promise.all([f.app.fetch(request.clone()), f.app.fetch(request.clone())]);
    assert.deepEqual([first.status, second.status].sort(), [200, 403]);
    await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
  });
  await assert.rejects(f.call("computer_upload", "source", "dest"), /transfer failed/);
  assert.equal((await f.app.fetch(f.requests[0])).status, 403);
  assert.equal((await f.read("/source")).toString(), "hello");
});

test("expired capability is refused and cleaned up", async t => {
  const f = await fixture(t);
  await f.volumes.put("alice", f.id, "/source", Buffer.from("hello"));
  f.intercept(async () => { f.advance(300001); });
  await assert.rejects(f.call("computer_upload", "source", "dest"), /transfer failed/);
  assert.equal((await f.app.fetch(f.requests[0])).status, 403);
  assert.equal((await f.db.query("select * from computer_transfers")).rowCount, 0);
});

test("read-only mounts, unmounted paths, directories and invalid paths are refused before exec", async t => {
  const f = await fixture(t);
  f.mounts[0].mode = "ro";
  await f.volumes.put("alice", f.id, "/source", Buffer.from("allowed"));
  await f.call("computer_upload", "source", "dest");
  await assert.rejects(f.call("computer_download", "dest", "copy"), /read-only/);
  await assert.rejects(f.call("computer_upload", "/another/source", "dest"), /not inside a mount/);
  await assert.rejects(f.call("computer_upload", "/workspace", "dest"), /source must be a file/);
  for (const path of ["", "bad\0path"]) await assert.rejects(f.call("computer_download", path, "copy"), /Invalid transfer path/);
  assert.equal(f.calls(), 1);
});

test("download enforces streaming size cap without content-length and preserves existing file", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "source"), "replacement");
  await f.volumes.put("alice", f.id, "/dest", Buffer.from("original"));
  f.intercept(async request => {
    await f.db.query("update computer_transfers set max_bytes=4");
    const body = new ReadableStream({ start(c) { c.enqueue(Buffer.from("abc")); c.enqueue(Buffer.from("de")); c.close(); } });
    const response = await f.app.fetch(new Request(request.url, { method: "PUT", body, duplex: "half" } as RequestInit));
    assert.equal(response.status, 413);
  });
  await assert.rejects(f.call("computer_download", "source", "dest"), /size limit/);
  assert.equal((await f.read("/dest")).toString(), "original");
});

test("download rejects oversized content-length and quota exhaustion with 507", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "source"), "replacement");
  f.intercept(async request => {
    const response = await f.app.fetch(new Request(request.url, { method: "PUT", headers: { "Content-Length": String(VOLUME_LIMITS.fileBytes + 1) }, body: "x" }));
    assert.equal(response.status, 413);
  });
  await assert.rejects(f.call("computer_download", "source", "oversize"), /size limit/);
  f.intercept(async request => {
    f.quota({ used: 10, limit: 10 });
    const response = await f.app.fetch(request.clone());
    assert.equal(response.status, 507);
  });
  await assert.rejects(f.call("computer_download", "source", "quota"), (error: any) => error.status === 507);
  await assert.rejects(f.read("/quota"), /does not exist/);
});

test("provider failures cannot leak capability URLs into errors or logs", async t => {
  const f = await fixture(t);
  await f.volumes.put("alice", f.id, "/source", Buffer.from("hello"));
  const logs: unknown[] = [];
  const log = console.log, error = console.error;
  console.log = (...args) => { logs.push(args); }; console.error = (...args) => { logs.push(args); };
  try {
    f.fail();
    await assert.rejects(f.call("computer_upload", "source", "dest"), (error: any) => {
      assert.doesNotMatch(String(error), /runtime\.example|token=/); return true;
    });
    assert.doesNotMatch(JSON.stringify(logs), /runtime\.example|token=/);
    assert.doesNotMatch(JSON.stringify((await f.db.query("select * from computer_operations")).rows), /runtime\.example|token=/);
  } finally { console.log = log; console.error = error; }
});

test("empty files and multi-chunk files transfer without exposing bytes", async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 3, 255)]) {
    await f.volumes.put("alice", f.id, "/source", bytes);
    const sent = await f.call("computer_upload", "source", "-file");
    assert.deepEqual(sent, { path: "-file", size: bytes.length, sha256: sha256(bytes) });
    const received = await f.call("computer_download", "-file", "dest");
    assert.deepEqual(received, { path: "/workspace/dest", size: bytes.length, sha256: sha256(bytes) });
    assert.deepEqual(await f.read("/dest"), bytes);
  }
});

test("query paths cannot redirect a bound download and revoked agents cannot use a capability", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "source"), "bytes");
  f.intercept(async request => {
    const response = await f.app.fetch(new Request(request.url + "&path=/other&volume=other&tenant=bob", { method: "PUT", body: "bound" }));
    assert.equal(response.status, 204);
  });
  await assert.rejects(f.call("computer_download", "source", "dest"), /transfer failed/);
  assert.equal((await f.read("/dest")).toString(), "bound");
  await assert.rejects(f.read("/other"), /does not exist/);
  f.intercept(async () => { await f.db.query("update agents set revoked=true where id='a'"); });
  await assert.rejects(f.call("computer_upload", "dest", "revoked"), /transfer failed/);
  assert.equal((await f.app.fetch(f.requests.at(-1)!)).status, 403);
});
