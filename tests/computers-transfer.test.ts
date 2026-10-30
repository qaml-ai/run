import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Computers } from "../src/computers/service.ts";
import { ComputerTransfers } from "../src/computers/transfers.ts";
import { FileLinks } from "../src/files.ts";
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
  const links = new FileLinks("test-secret", "https://runtime.example");
  const transfers = new ComputerTransfers({ volumes, links });
  const app = api({ links, volumes, accounts: { db } } as any);
  const directory = await mkdtemp(join(tmpdir(), "computer-transfer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: Request[] = [];
  let intercept: ((request: Request) => Promise<Response | void>) | undefined;
  let corrupt = false;
  let fail = false;
  const accounts = new Accounts({ db, tenants: new Tenants({ read: async () => '{"tenants":{}}' }), secretsKey: "ab".repeat(32) });
  const service = new Computers({ db, accounts, outbound: new Outbound(), transfers, now: () => now, driver: () => ({
    async create(id) { return { id }; }, async close() {},
    async call(_ref, operation, args) {
      calls++;
      assert.equal(operation, "computer_exec");
      // Execute the real shell command, substituting curl with an argv capture. The fake then
      // streams files through the real API handler, without a socket or provider network.
      await exec("bash", ["-c", 'curl() { printf "%s\\0" "$@" > curl-args; return 77; }; ' + args.command], { cwd: directory }).catch(() => {});
      const argv = (await readFile(join(directory, "curl-args"), "utf8")).split("\0").filter(Boolean);
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
      const response = await intercept?.(request) ?? await app.fetch(request);
      if (response.ok && !upload) await writeFile(join(directory, path), Buffer.from(await response.arrayBuffer()));
      if (corrupt && response.ok && !upload) await writeFile(join(directory, path), "wrong bytes");
      const receipt = await exec("bash", ["-c", `curl() { printf '${response.status}'; return ${response.ok ? 0 : 22}; }; ` + args.command], { cwd: directory }).then(
        result => ({ exitCode: 0, stdout: result.stdout }),
        error => ({ exitCode: error.code, stdout: error.stdout }),
      );
      return { ...receipt, stderr: `untrusted error ${url}` };

    },
  }) });
  await service.create("alice", { agent: "a", provider: "sprites", credentials: { apiKey: "fake" }, leaseSeconds: 900, dailySeconds: 900 });
  await service.call("alice", "a", "computer_start", {}, "start");
  let key = 0;
  const writes: unknown[] = [];
  return { db, volumes, id, mounts, directory, app, requests, transfers, links,
    call: (name: string, from: string, to: string, requestKey = String(++key)) => service.call("alice", "a", name, { from, to }, requestKey, { mounts, onWrite: file => writes.push(file) }),
    writes, calls: () => calls, advance: (ms: number) => now += ms,
    intercept: (fn: typeof intercept) => intercept = fn, fail: () => fail = true, corrupt: () => corrupt = true,
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
  assert.equal((await f.db.query("select to_regclass('computer_transfers') as table_name")).rows[0].table_name, null);
});

test("signed links bind the direction and file, expire in 120 seconds and can be reused", async t => {
  const f = await fixture(t);
  await f.volumes.put("alice", f.id, "/source", Buffer.from("hello"));
  f.intercept(async request => {
    const token = new URL(request.url).pathname.split("/")[3];
    const grant = f.links.verify(token);
    assert.equal(grant.tenant, "alice"); assert.equal(grant.agent, "a");
    assert.equal(grant.volume, f.id); assert.equal(grant.path, "/source");
    assert.ok(grant.expiresAt > Date.now() + 119000 && grant.expiresAt <= Date.now() + 120000);
    assert.equal((await f.app.fetch(new Request(request.url, { method: "PUT", body: "overwrite" }))).status, 405);
    assert.equal((await f.app.fetch(new Request(request.url.replace(token, token + "x")))).status, 403);
    const first = await f.app.fetch(request.clone()), second = await f.app.fetch(request.clone());
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal(await first.text(), "hello"); assert.equal(await second.text(), "hello");
  });
  await f.call("computer_upload", "source", "dest");
  assert.equal((await f.app.fetch(f.requests[0])).status, 200);
});

test("expired signed links are refused", async t => {
  const f = await fixture(t);
  const { url } = f.links.sign({ tenant: "alice", volume: f.id, path: "/source", method: "GET", expiresIn: 1 });
  const now = Date.now;
  Date.now = () => now() + 1001;
  try { assert.equal((await f.app.fetch(new Request(url))).status, 403); }
  finally { Date.now = now; }
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
    let remaining = VOLUME_LIMITS.fileBytes + 1;
    const chunk = Buffer.alloc(1024 * 1024);
    const body = new ReadableStream({ pull(c) { if (!remaining) return c.close(); const next = chunk.subarray(0, Math.min(remaining, chunk.length)); remaining -= next.length; c.enqueue(next); } });
    const response = await f.app.fetch(new Request(request.url, { method: "PUT", body, duplex: "half" } as RequestInit));
    assert.equal(response.status, 413);
    return response;
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
    return response;
  });
  await assert.rejects(f.call("computer_download", "source", "oversize"), /size limit/);
  f.intercept(async request => {
    f.quota({ used: 10, limit: 10 });
    const response = await f.app.fetch(request.clone());
    assert.equal(response.status, 507);
    return response;
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
    const response = await f.app.fetch(new Request(request.url + "?path=/other&volume=other&tenant=bob", { method: "PUT", body: "bound" }));
    assert.equal(response.status, 201);
  });
  await f.call("computer_download", "source", "dest");
  assert.equal((await f.read("/dest")).toString(), "bytes");
  await assert.rejects(f.read("/other"), /does not exist/);
  f.intercept(async () => { await f.db.query("update agents set revoked=true where id='a'"); });
  await assert.rejects(f.call("computer_upload", "dest", "revoked"), /transfer failed/);
  assert.equal((await f.app.fetch(f.requests.at(-1)!)).status, 403);
});

test("a remote file with the wrong size or digest fails verification", async t => {
  const f = await fixture(t);
  await f.volumes.put("alice", f.id, "/source", Buffer.from("right bytes"));
  f.corrupt();
  await assert.rejects(f.call("computer_upload", "source", "dest"), /transfer failed/);
});

test("download verifies the digest against the remote file, not just the byte count", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "source"), "right bytes");
  f.intercept(async request => f.app.fetch(new Request(request.url, { method: "PUT", body: "wrong bytes" })));
  await assert.rejects(f.call("computer_download", "source", "dest"), /transfer failed/);
});
