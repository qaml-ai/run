import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import { promisify } from "node:util";
import { startFixture } from "./fixture.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHubApp, type FakeGitHubApp } from "../../../tests/github-app-fake.ts";

async function dockerUnavailable() {
  for (const args of [["info"], ["buildx", "version"]]) {
    try {
      await promisify(execFile)("docker", args, { timeout: 10_000 });
    } catch {
      return `Native Docker computer tests require a running local Docker daemon with Buildx (docker ${args.join(" ")} failed).`;
    }
  }
}

const unavailable = await dockerUnavailable();
const requireDocker = process.env.WORKERS_REQUIRE_DOCKER === "1";
const run = promisify(execFile);

// workerd puts every local container behind an egress sidecar, Cloudflare's proxy-everything (the image Wrangler pins),
// which steers the container's traffic with iptables TPROXY rules. One of them, `-m socket -j DIVERT`, needs the
// kernel's xt_socket, and a kernel without it (Sprites, 6.12-fly, measured 2026-11-06) makes the sidecar exit with
// "Extension socket revision 0 not supported", so no container starts. The rule only short-cuts packets of connections
// that already have a local socket; the TPROXY target looks those sockets up itself. So when the probe below finds no
// xt_socket, the fixture runs the same pinned image with an iptables wrapper that drops that one rule when the kernel
// refuses it (any other failure still fails). Wrangler `docker pull`s the egress image before every start, so the
// derived image is served from a throwaway registry on loopback. With xt_socket (CI), nothing changes.
async function egressImageWithoutSocketMatch(t: { after(fn: () => Promise<void>): void; diagnostic(message: string): void }) {
  const cli = await readFile(new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url), "utf8");
  const image = /DEFAULT_CONTAINER_EGRESS_INTERCEPTOR_IMAGE\w* = "([^"]+)"/.exec(cli)?.[1];
  assert.ok(image, "Wrangler's pinned egress interceptor image");
  try {
    await run("docker", ["run", "--rm", "--cap-add", "NET_ADMIN", "--entrypoint", "iptables", image, "-t", "mangle", "-A", "PREROUTING", "-p", "tcp", "-m", "socket", "-j", "ACCEPT"], { timeout: 120_000 });
    return;
  } catch (error) {
    if (!String((error as { stderr?: string }).stderr).includes("Extension socket")) throw error;
  }
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    }).on("error", reject);
  });
  const registry = `camelrun-egress-registry-${port}`;
  const tag = `127.0.0.1:${port}/camelrun-egress-without-socket-match:${image.split("@sha256:")[1]?.slice(0, 12) ?? "local"}`;
  t.after(async () => {
    await run("docker", ["rm", "-f", registry], { timeout: 30_000 }).catch(() => {});
  });
  await run("docker", ["run", "-d", "--name", registry, "--network", "host", "-e", `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`, "registry:2"], { timeout: 120_000 });
  // /usr/local/sbin comes first on the image's PATH, so the wrapper shadows iptables and calls the real one.
  const wrapper = [
    "#!/bin/sh",
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin "$(basename "$0")" "$@" && exit 0',
    "code=$?",
    'case " $* " in *" -m socket "*) echo "skipped (no xt_socket in this kernel): $(basename "$0") $*" >&2; exit 0 ;; esac',
    "exit $code",
  ].join("\n");
  const dockerfile = ["iptables", "ip6tables"].reduce(
    (file, name) => `${file}COPY --chmod=755 <<'EOF' /usr/local/sbin/${name}\n${wrapper}\nEOF\n`,
    `FROM ${image}\n`,
  );
  const build = run("docker", ["build", "-q", "-t", tag, "-"], { timeout: 300_000 });
  build.child.stdin?.end(dockerfile);
  await build;
  for (let attempt = 0; ; attempt++) {
    try {
      await run("docker", ["push", "-q", tag], { timeout: 120_000 });
      break;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  t.diagnostic(`no xt_socket in this kernel: egress sidecar ${image} runs with its -m socket rule dropped, as ${tag}`);
  return tag;
}

test(
  "the native computer: a container its Durable Object drives (durable_object scheduling policy) in local Docker",
  // On a sprite with a cold image cache, pulling and building every image inside this test took 206 s of the old 240.
  { timeout: 360_000, skip: requireDocker ? false : unavailable },
  async (t) => {
    assert.equal(unavailable, undefined, unavailable);
    const egressImage = await egressImageWithoutSocketMatch(t);
    if (egressImage) {
      process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
      t.after(() => {
        delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE;
      });
    }
    const fixture = await startFixture({ config: "wrangler.computers.test.jsonc" });
    const { worker: server, token } = fixture;
    t.after(async () => {
      // Native Container local emulation can leave its Docker network proxy up
      // after destroy(). Remove only containers named in this test's own log.
      const names = new Set(
        [
          ...server
            .logs()
            .matchAll(
              /containerName = (workerd-camelrun-proto-workers-computers-local-ContainerComputer-[a-f0-9]{64})/g,
            ),
        ].map((match) => match[1]),
      );
      await fixture.stop();
      for (const name of names) {
        for (const target of [name, `${name}-proxy`]) {
          try {
            await promisify(execFile)("docker", ["rm", "-f", target], {
              timeout: 10000,
            });
          } catch (error) {
            if (
              !String((error as { stderr?: string }).stderr).includes(
                "No such container",
              )
            )
              throw error;
          }
        }
      }
    });
    try {
      const create = await fetch(`${server.url}/v1/agents`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test/echo" }),
      });
      assert.equal(create.status, 201, await create.clone().text());
      const { id, token: agentToken } = (await create.json()) as { id: string; token: string };
      const call = async (
        provider: string,
        request: object,
        expectedStatus = 200,
      ) => {
        const response = await fetch(
          `${server.url}/experimental/agents/${id}/computer`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ provider, ...request }),
            signal: AbortSignal.timeout(60000),
          },
        );
        assert.equal(
          response.status,
          expectedStatus,
          `${await response.clone().text()}\n${server.logs()}`,
        );
        return (await response.json()) as Record<string, any>;
      };
      for (const provider of ["container"])
        await t.test(provider, async (t) => {
          const start = performance.now();
          const result = await call(provider, {
            op: "exec",
            argv: ["node", "-e", "console.log('local Linux')"],
          });
          assert.equal(result.exitCode, 0);
          assert.match(result.stdout, /local Linux/);
          t.diagnostic(
            `cold_start_ms=${Math.round(performance.now() - start)}`,
          );
          await call(provider, {
            op: "write",
            path: "test.txt",
            content: "persistent snapshot content",
          });
          assert.equal(
            (await call(provider, { op: "read", path: "test.txt" })).content,
            "persistent snapshot content",
          );
          // Traverse the actual model -> codemode -> registered computer tool path.
          const requestId = `nested-${provider}`;
          const submit = await fetch(`${server.url}/clients/${id}/requests`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${agentToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              id: requestId,
              method: "prompt",
              params: {
                text: `code:text(await tools.computer({provider:"${provider}",op:"exec",argv:["node","-e","console.log('nested computer')"]}));`,
              },
            }),
          });
          assert.equal(submit.status, 202, await submit.text());
          const settled = await fetch(
            `${server.url}/clients/${id}/requests/${requestId}?wait=20`,
            { headers: { authorization: `Bearer ${agentToken}` } },
          );
          const record = (await settled.json()) as any;
          assert.equal(record.state, "completed", JSON.stringify(record));
          assert.match(record.outcome.result.reply, /nested computer/);
          await call(provider, {
            op: "write",
            path: "table.csv",
            content: '"a,b",c\r\n"d""e",f\n',
          });
          const parsedCsv = await call(provider, {
            op: "parse",
            path: "table.csv",
            format: "csv",
          });
          assert.equal(parsedCsv.text, 'a,b\tc\nd"e\tf');
          assert.equal(parsedCsv.truncated, false);
          await call(provider, {
            op: "write",
            path: "page.html",
            content:
              "<h1>Title</h1><script>danger()</script><p>Hello &amp; world</p>",
          });
          const parsedHtml = await call(provider, {
            op: "parse",
            path: "page.html",
            format: "html",
          });
          assert.equal(parsedHtml.text, "Title\nHello & world");
          await call(provider, {
            op: "write",
            path: "object.json",
            content: '{"answer":42}',
          });
          assert.match(
            (
              await call(provider, {
                op: "parse",
                path: "object.json",
                format: "json",
              })
            ).text,
            /"answer": 42/,
          );
          if (provider === "container") {
            await call(provider, {
              op: "exec",
              argv: [
                "node",
                "-e",
                "require('node:fs').writeFileSync('/workspace/large.txt','a'.repeat(100000))",
              ],
            });
            const bounded = await call(provider, {
              op: "parse",
              path: "large.txt",
              format: "text",
            });
            assert.equal(bounded.truncated, true);
            assert.ok(bounded.text.length <= 60000);
            await call(provider, {
              op: "exec",
              argv: [
                "node",
                "-e",
                "require('node:fs').writeFileSync('/workspace/over.txt','a'.repeat(8*1024*1024+1))",
              ],
            });
            await call(
              provider,
              { op: "parse", path: "over.txt", format: "text" },
              500,
            );
          }

          const network = await call(provider, {
            op: "exec",
            argv: [
              "node",
              "-e",
              "fetch('https://example.com',{signal:AbortSignal.timeout(10000)}).then(()=>console.log('reachable')).catch(()=>process.exit(3))",
            ],
          });
          assert.equal(network.exitCode, 0);
          assert.match(network.stdout, /reachable/);
          await call(provider, { op: "snapshot", name: "saved" });
          await call(provider, {
            op: "write",
            path: "test.txt",
            content: "modified",
          });
          await call(provider, { op: "sleep" });
          const resume = performance.now();
          await call(provider, { op: "restore", name: "saved" });
          assert.equal(
            (await call(provider, { op: "read", path: "test.txt" })).content,
            "persistent snapshot content",
          );
          t.diagnostic(
            `restore_and_read_ms=${Math.round(performance.now() - resume)}`,
          );
          // Fork: two other agents' computers start from one snapshot of this running computer (the fork RPCs).
          const children: string[] = [];
          for (const name of ["fork-a", "fork-b"]) {
            const made = await fetch(`${server.url}/v1/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "test/echo", name }) });
            assert.equal(made.status, 201, await made.clone().text());
            children.push(((await made.json()) as { id: string }).id);
          }
          const fork = async (batch: string, expected = 200) => {
            const response = await fetch(`${server.url}/experimental/agents/${id}/__test/computer-fork`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ batch, into: children }),
              signal: AbortSignal.timeout(120000),
            });
            assert.equal(response.status, expected, `${await response.clone().text()}\n${server.logs()}`);
            return (await response.json()) as { snapshot: { id: string; image: string } };
          };
          const forkStart = performance.now();
          const first = await fork("integration:m1");
          t.diagnostic(`fork_snapshot_ms=${Math.round(performance.now() - forkStart)}`);
          assert.ok(first.snapshot.image, "the handle records its image");
          assert.equal((await fork("integration:m1")).snapshot.id, first.snapshot.id, "one snapshot serves every child of a call");
          const childCall = async (child: string, request: object) => {
            const response = await fetch(`${server.url}/experimental/agents/${child}/computer`, {
              method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ provider, ...request }), signal: AbortSignal.timeout(60000),
            });
            assert.equal(response.status, 200, `${await response.clone().text()}\n${server.logs()}`);
            return (await response.json()) as Record<string, any>;
          };
          const restoreStart = performance.now();
          const reads = await Promise.all(children.map((child) => childCall(child, { op: "read", path: "test.txt" })));
          t.diagnostic(`fork_restore_and_read_2_ms=${Math.round(performance.now() - restoreStart)}`);
          for (const read of reads) {
            assert.equal(read.content, "persistent snapshot content");
            assert.deepEqual(read.computer, { restoredFrom: "fork" });
          }
          // Each fork is its own machine: a child's writes reach neither its sibling nor the parent.
          await childCall(children[0], { op: "write", path: "test.txt", content: "child a" });
          assert.equal((await childCall(children[1], { op: "read", path: "test.txt" })).content, "persistent snapshot content");
          assert.equal((await call(provider, { op: "read", path: "test.txt" })).content, "persistent snapshot content");
          await call(provider, { op: "write", path: "test.txt", content: "parent later" });
          assert.equal((await childCall(children[0], { op: "read", path: "test.txt" })).content, "child a");
          for (const child of children) {
            const removed = await fetch(`${server.url}/v1/agents/${child}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
            assert.equal(removed.status, 200, await removed.clone().text());
          }
          // Sleep saves the disk: the next operation resumes it.
          assert.deepEqual(await call(provider, { op: "sleep" }), { sleeping: true, saved: true });
          const resumed = await call(provider, { op: "read", path: "test.txt" });
          assert.equal(resumed.content, "parent later");
          assert.equal(resumed.computer.restoredFrom, "sleep");
          await call(provider, { op: "sleep" });
        });
      // Deleting the agent purges its computer: container and snapshot handles.
      await call("container", { op: "exec", argv: ["true"] });
      const removed = await fetch(`${server.url}/v1/agents/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(removed.status, 200, await removed.clone().text());
      // Every container session (the agent's own and the three forks) was metered as platform-paid computer time.
      const usage = await fetch(`${server.url}/v1/usage?days=1`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(usage.status, 200, await usage.clone().text());
      const computer = ((await usage.json()) as { days: { kind: string; model: string; cost: number; platformCost: number; responses: number }[] })
        .days.filter((row) => row.kind === "computer");
      assert.deepEqual(computer.map((row) => row.model), ["cloudflare/lite"], JSON.stringify(computer));
      assert.ok(computer[0].cost > 0 && computer[0].platformCost === computer[0].cost, JSON.stringify(computer));
      assert.equal(computer[0].responses, 0, "container time is not a model response");
      t.diagnostic(`computer_cost_usd=${computer[0].cost}`);
    } catch (error) {
      t.diagnostic(server.logs());
      throw error;
    }
  },
);

// Egress grants and the parent fork run here, after the test above, rather than in a file of their own: two fixtures
// of this configuration at once (integration files run in parallel) race on its one image and fail to start containers.
const TOKEN = "ghs_egress_integration_token_0123456789";
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;

const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
};
const close = (server: ReturnType<typeof createHttpServer>) => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); };

/** Git's smart HTTP through `git http-backend`, standing in for github.com: it serves only the runtime's credential. */
async function gitServer(root: string) {
  const seen: { path: string; authorization?: string; host?: string }[] = [];
  const { server, origin } = await listen((request, response) => {
    const url = new URL(request.url!, "http://local");
    seen.push({ path: url.pathname, authorization: request.headers.authorization, host: request.headers["x-camelrun-egress-host"] as string | undefined });
    if (request.headers["x-camelrun-egress-host"] !== "github.com") { response.writeHead(421); response.end("not routed by the egress gateway"); return; }
    if (request.headers.authorization !== BASIC) { response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }); response.end(); return; }
    const cgi = spawn("git", ["http-backend"], { env: {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "x-access-token",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!,
      CONTENT_TYPE: request.headers["content-type"] ?? "", ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}),
    } });
    request.pipe(cgi.stdin);
    let head = Buffer.alloc(0), sent = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (sent) { response.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [name, ...rest] = line.split(":"), value = rest.join(":").trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.write(head.subarray(end + 4));
      sent = true;
    });
    cgi.on("close", () => response.end());
  });
  return { server, origin, seen };
}

test("computer egress: git clone and push through the runtime's credential gateway, and a child forks its parent's machine", {
  timeout: 600_000, skip: requireDocker ? false : unavailable,
}, async (t) => {
  assert.equal(unavailable, undefined, unavailable);
  const egressImage = await egressImageWithoutSocketMatch(t);
  if (egressImage) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
    t.after(() => { delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE; });
  }
  const repos = await mkdtemp(join(tmpdir(), "camelrun-egress-git-"));
  t.after(() => rm(repos, { recursive: true, force: true }));
  await run("git", ["init", "--bare", "-b", "main", join(repos, "acme/app.git")]);
  const seed = join(repos, "seed");
  await run("git", ["clone", join(repos, "acme/app.git"), seed]);
  await run("sh", ["-c", `cd ${seed} && echo '# app' > README.md && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin HEAD:main`]);
  const git = await gitServer(repos);
  t.after(() => close(git.server));

  const exchanges: Record<string, any>[] = [];
  const exchange = await listen(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const jwt = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    exchanges.push({ body: JSON.parse(raw), claims: JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ token: TOKEN, expiresIn: 3600 }));
  });
  t.after(() => close(exchange.server));

  // A scripted model: the parent spawns one inline child, which answers at once.
  const model = await listen(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), text = JSON.stringify(body.messages);
    const delta = text.includes("FORK_CHILD") || body.messages.at(-1).role === "tool" || text.includes("agent_notification")
      ? { role: "assistant", content: "done" }
      : { role: "assistant", tool_calls: [{ index: 0, id: "spawn-1", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ instructions: "FORK_CHILD", task: "Work in a fork", name: "worker" }) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => close(model.server));

  const fixture = await startFixture({ config: "wrangler.computers.test.jsonc", modelURL: `${model.origin}/v1`, vars: { TEST_EGRESS_UPSTREAM: git.origin } });
  t.after(async () => {
    const names = new Set([...fixture.worker.logs().matchAll(/containerName = (workerd-camelrun-proto-workers-computers-local-(?:ContainerComputer|SandboxComputer)-[a-f0-9]{64})/g)].map(match => match[1]));
    await fixture.stop();
    for (const name of names) for (const target of [name, `${name}-proxy`]) await run("docker", ["rm", "-f", target]).catch(() => {});
  });
  t.after(() => { if (process.env.EGRESS_DEBUG) console.log(fixture.worker.logs().slice(-20000)); });
  const api = async (path: string, init: { method?: string; body?: unknown; key?: string } = {}, expected = [200, 201, 202]) => {
    const response = await fetch(fixture.url + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json", ...(init.key ? { "idempotency-key": init.key } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(200_000),
    });
    const value = await response.json() as any;
    assert.ok(expected.includes(response.status), `${path}: ${response.status} ${JSON.stringify(value)}\n${fixture.worker.logs().slice(-4000)}`);
    return value;
  };
  const computer = (agent: string, request: object, expected?: number[]) => api(`/experimental/agents/${agent}/computer`, { body: { provider: "container", ...request } }, expected);
  const sh = async (agent: string, command: string, timeoutMs = 120_000) => {
    const started = performance.now();
    const result = await computer(agent, { op: "exec", argv: ["bash", "-lc", command], timeoutMs });
    return { ...result, ms: Math.round(performance.now() - started) };
  };

  // Definitions refuse a computer they cannot use, and agents cannot set one themselves.
  await api("/v1/definitions", { body: { name: "Bad", computer: { egress: [{ host: "10.0.0.1" }] } } }, [400]);
  await api("/v1/agents", { body: { computer: { egress: [{ host: "github.com" }] } } }, [400]);

  const definition = await api("/v1/definitions", { key: "egress-lead", body: {
    name: "Lead", builtins: ["agents"], delegate: { instructions: true }, codeMode: false, fileTools: false,
    computer: { idleSeconds: 600, egress: [{ host: "github.com", auth: { type: "exchange", url: `${exchange.origin}/token` }, scheme: "basic" }] },
  } });
  assert.deepEqual(definition.computer.egress[0], { host: "github.com", auth: { type: "exchange", url: `${exchange.origin}/token` }, scheme: "basic" });
  const lead = await api("/v1/agents", { body: { definition: definition.id } });

  const clone = await sh(lead.id, "git clone -q https://github.com/acme/app.git /workspace/app && git -C /workspace/app log --format=%s -1");
  assert.equal(clone.exitCode, 0, JSON.stringify(clone));
  assert.equal(clone.stdout.trim(), "init");
  t.diagnostic(`first_exec_with_clone_ms=${clone.ms}`);
  const push = await sh(lead.id, "cd /workspace/app && git switch -qc camel/badge && echo badge >> README.md && git -c user.name=camel -c user.email=c@c commit -qam badge && git push -q origin camel/badge");
  assert.equal(push.exitCode, 0, JSON.stringify(push));
  assert.equal((await run("git", ["--git-dir", join(repos, "acme/app.git"), "log", "--format=%s", "-1", "camel/badge"])).stdout.trim(), "badge");
  assert.ok(git.seen.some(request => request.path.endsWith("/git-receive-pack")));
  assert.ok(git.seen.every(request => request.authorization === BASIC), "every request reached the host with the runtime's credential");

  // The exchange was asked as this agent, for this grant.
  assert.equal(exchanges[0].claims.tenant, "camelrun-proto-local");
  assert.equal(exchanges[0].claims.agent, lead.id);
  assert.equal(exchanges[0].claims.definition, definition.id);
  assert.deepEqual(exchanges[0].claims.exchange, { server: "computer:github.com", url: "https://github.com" });
  assert.equal(exchanges[0].claims.aud, `${exchange.origin}/token`);

  // The machine never holds the credential, and hosts without a grant are reached directly.
  const hygiene = await sh(lead.id, `env; cat /workspace/app/.git/config; cat ~/.git-credentials 2>/dev/null; grep -rIl ${TOKEN} /workspace /root /tmp /etc 2>/dev/null; true`);
  assert.equal(hygiene.stdout.includes(TOKEN) || hygiene.stdout.includes(BASIC.slice(6)), false);
  const direct = await sh(lead.id, "curl -sS -m 10 https://example.com/ >/dev/null && echo reachable || echo blocked");
  assert.match(direct.stdout, /reachable/);

  // The project machine: snapshot it for children to fork.
  const backup = performance.now();
  await computer(lead.id, { op: "snapshot", name: "base" });
  t.diagnostic(`snapshot_ms=${Math.round(performance.now() - backup)}`);

  // A runtime-made child restores the parent's backup into its own computer, and inherits the parent's egress.
  const started = await api(`/v1/agents/${lead.id}/prompt`, { body: { text: "start" } });
  let child: string | undefined;
  for (const deadline = Date.now() + 60_000; !child && Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 200)))
    child = (await fixture.db.query("select id from agents where header->>'parentAgentId'=$1", [lead.id])).rows[0]?.id;
  assert.ok(child, `no child of ${lead.id} (request ${started.id})`);
  const fork = performance.now();
  const seeded = await api(`/experimental/agents/${lead.id}/__test/computer-fork`, { body: { batch: "egress:m1", into: [child!] } });
  assert.ok(seeded.snapshot.id);
  t.diagnostic(`fork_snapshot_ms=${Math.round(performance.now() - fork)}`);
  const forked = await sh(child!, "git -C /workspace/app log --format=%s -1 && git -C /workspace/app fetch -q origin && git -C /workspace/app branch -r");
  t.diagnostic(`fork_restore_first_exec_ms=${forked.ms}`);
  assert.equal(forked.exitCode, 0, JSON.stringify(forked));
  assert.equal(forked.computer?.restoredFrom, "fork");
  assert.match(forked.stdout, /^badge\n/);
  assert.match(forked.stdout, /origin\/main/);
  assert.ok(exchanges.some(entry => entry.claims.agent === child), "the child's egress credential is its own");

  // A child's fork never changes its parent's machine; a computer that never ran has nothing to fork.
  await sh(child!, "touch /workspace/child-only");
  assert.match((await sh(lead.id, "test -e /workspace/child-only && echo shared || echo separate")).stdout, /separate/);
  const idle = await api("/v1/agents", { body: { definition: definition.id } });
  const nothing = await api(`/experimental/agents/${idle.id}/__test/computer-fork`, { body: { batch: "egress:m2", into: [child!] } }, [409]);
  assert.equal(nothing.code, "NO_SESSION");
});

/** Git's smart HTTP for the GitHub App case: it serves a repository only to a token the fake GitHub minted for it, and a push only with contents: write. */
async function appGitServer(root: string, github: FakeGitHubApp) {
  const seen: { path: string; reached: boolean; host?: string }[] = [];
  const { server, origin } = await listen((request, response) => {
    const url = new URL(request.url!, "http://local");
    const [, owner, repo] = /^\/([^/]+)\/([^/]+)\.git\//.exec(url.pathname) ?? [];
    const issued = github.tokenFor(request.headers.authorization);
    const push = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
    const reached = !!owner && github.reaches(issued, owner, repo!) && (!push || issued!.permissions.contents === "write");
    seen.push({ path: url.pathname, reached, host: request.headers["x-camelrun-egress-host"] as string | undefined });
    if (request.headers["x-camelrun-egress-host"] !== "github.com") { response.writeHead(421); response.end("not routed by the egress gateway"); return; }
    if (!issued) { response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }); response.end(); return; }
    if (!reached) { response.writeHead(403); response.end("Write access to repository not granted."); return; }
    const cgi = spawn("git", ["http-backend"], { env: {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "x-access-token",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!,
      CONTENT_TYPE: request.headers["content-type"] ?? "", ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}),
    } });
    request.pipe(cgi.stdin);
    let head = Buffer.alloc(0), sent = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (sent) { response.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [name, ...rest] = line.split(":"), value = rest.join(":").trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.write(head.subarray(end + 4));
      sent = true;
    });
    cgi.on("close", () => response.end());
  });
  return { server, origin, seen };
}

test("computer egress with a GitHub App: a git push gets a token the runtime mints, scoped to the grant's repository; deleting the App stops it", {
  timeout: 600_000, skip: requireDocker ? false : unavailable,
}, async (t) => {
  assert.equal(unavailable, undefined, unavailable);
  const egressImage = await egressImageWithoutSocketMatch(t);
  if (egressImage) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
    t.after(() => { delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE; });
  }
  const github = await fakeGitHubApp(t);
  const repos = await mkdtemp(join(tmpdir(), "camelrun-egress-app-"));
  t.after(() => rm(repos, { recursive: true, force: true }));
  for (const name of ["app", "other"]) {
    await run("git", ["init", "--bare", "-b", "main", join(repos, `acme/${name}.git`)]);
    const seed = join(repos, `seed-${name}`);
    await run("git", ["clone", join(repos, `acme/${name}.git`), seed]);
    await run("sh", ["-c", `cd ${seed} && echo '# ${name}' > README.md && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git push -q origin HEAD:main`]);
  }
  const git = await appGitServer(repos, github);
  t.after(() => close(git.server));
  const model = await listen(async (request, response) => {
    for await (const _chunk of request) { /* drained */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => close(model.server));

  const fixture = await startFixture({ config: "wrangler.computers.test.jsonc", modelURL: `${model.origin}/v1`, vars: { TEST_EGRESS_UPSTREAM: git.origin, AGENT_GITHUB_API_URL: github.url } });
  t.after(async () => {
    const names = new Set([...fixture.worker.logs().matchAll(/containerName = (workerd-camelrun-proto-workers-computers-local-(?:ContainerComputer|SandboxComputer)-[a-f0-9]{64})/g)].map(match => match[1]));
    await fixture.stop();
    for (const name of names) for (const target of [name, `${name}-proxy`]) await run("docker", ["rm", "-f", target]).catch(() => {});
  });
  const api = async (path: string, init: { method?: string; body?: unknown } = {}, expected = [200, 201, 202]) => {
    const response = await fetch(fixture.url + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(200_000),
    });
    const text = await response.text();
    assert.ok(expected.includes(response.status), `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-4000)}`);
    return { ...JSON.parse(text || "{}"), text } as any;
  };
  const sh = (agent: string, command: string) => api(`/experimental/agents/${agent}/computer`, { body: { provider: "container", op: "exec", argv: ["bash", "-lc", command], timeoutMs: 120_000 } });

  const app = await api("/v1/github-apps", { body: { name: "code", appId: "5151", privateKey: github.state.pem } });
  assert.doesNotMatch(app.text, /PRIVATE KEY/);
  await api("/v1/definitions", { body: { name: "Bad", computer: { egress: [{ host: "registry.npmjs.org", auth: { type: "github-app", app: "code" } }] } } }, [400]);
  const definition = await api("/v1/definitions", { body: {
    name: "Coder", codeMode: false, fileTools: false,
    computer: { idleSeconds: 600, egress: [{ host: "github.com", auth: { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "write", metadata: "read" } } }] },
  } });
  assert.deepEqual(definition.computer.egress[0], { host: "github.com", auth: { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "write", metadata: "read" } }, scheme: "basic" });
  const agent = await api("/v1/agents", { body: { definition: definition.id } });

  const pushed = await sh(agent.id, "git clone -q https://github.com/acme/app.git /workspace/app && cd /workspace/app && git switch -qc camel/badge && echo badge >> README.md && git -c user.name=camel -c user.email=c@c commit -qam badge && git push -q origin camel/badge");
  assert.equal(pushed.exitCode, 0, JSON.stringify(pushed));
  assert.equal((await run("git", ["--git-dir", join(repos, "acme/app.git"), "log", "--format=%s", "-1", "camel/badge"])).stdout.trim(), "badge");
  assert.ok(git.seen.some(request => request.path.endsWith("/git-receive-pack") && request.reached));
  // One token, for this repository with these permissions, minted by the App for acme's installation.
  assert.deepEqual(github.minted().map(entry => [entry.installation, entry.repositories, entry.permissions]), [[101, ["app"], { contents: "write", metadata: "read" }]]);

  // The grant's token reaches no other repository of the installation.
  const other = await sh(agent.id, "git clone -q https://github.com/acme/other.git /workspace/other 2>&1; echo exit=$?");
  assert.match(other.stdout, /exit=128/);
  assert.ok(git.seen.some(request => request.path.startsWith("/acme/other.git/") && !request.reached));
  assert.equal(github.minted().length, 1);

  // The machine never holds the token.
  const hygiene = await sh(agent.id, "env; cat /workspace/app/.git/config; cat ~/.git-credentials 2>/dev/null; grep -rIl ghs_ /workspace /root /tmp /etc 2>/dev/null; true");
  for (const issued of github.state.issued) assert.ok(!hygiene.stdout.includes(issued.token));
  assert.doesNotMatch(fixture.worker.logs(), /ghs_[a-f0-9]{8}/);

  // Deleted: the gateway has no credential for the grant, and git is refused.
  await api(`/v1/github-apps/${app.id}`, { method: "DELETE" });
  const after = await sh(agent.id, "git -C /workspace/app fetch -q origin 2>&1; echo exit=$?");
  assert.match(after.stdout, /exit=128/);
  assert.equal(github.minted().length, 1, "nothing minted after the App is deleted");
});

test('computer.idle "sleep": a machine that idles out saves its disk, and the next operation resumes it', {
  timeout: 300_000, skip: requireDocker ? false : unavailable,
}, async (t) => {
  assert.equal(unavailable, undefined, unavailable);
  const egressImage = await egressImageWithoutSocketMatch(t);
  if (egressImage) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
    t.after(() => { delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE; });
  }
  const fixture = await startFixture({ config: "wrangler.computers.test.jsonc" });
  t.after(async () => {
    const names = new Set([...fixture.worker.logs().matchAll(/containerName = (workerd-camelrun-proto-workers-computers-local-ContainerComputer-[a-f0-9]{64})/g)].map(match => match[1]));
    await fixture.stop();
    for (const name of names) for (const target of [name, `${name}-proxy`]) await run("docker", ["rm", "-f", target]).catch(() => {});
  });
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}\n${fixture.worker.logs().slice(-4000)}`);
    return value;
  };
  const definition = await api("/v1/definitions", { name: "Sleeper", computer: { idleSeconds: 10, idle: "sleep" } });
  assert.equal(definition.computer.idle, "sleep");
  const agent = await api("/v1/agents", { definition: definition.id });
  const computer = (request: object) => api(`/experimental/agents/${agent.id}/computer`, { provider: "container", ...request });
  await computer({ op: "write", path: "kept.txt", content: "still here" });
  // The DO's alarm puts it to sleep at the idle point; wait past it.
  await new Promise(resolve => setTimeout(resolve, 25_000));
  const resumed = await computer({ op: "read", path: "kept.txt" });
  assert.equal(resumed.content, "still here");
  assert.equal(resumed.computer?.restoredFrom, "sleep", JSON.stringify(resumed));
});
