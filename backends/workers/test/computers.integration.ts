import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  // Cold image builds can take five minutes before this test exercises the running containers.
  { timeout: 600_000, skip: requireDocker ? false : unavailable },
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
      const post = (path: string, body: object) => fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      // An agent has a computer only when its definition declares one: `computer: {}` is the default computer.
      const defined = await post("/v1/definitions", { name: "Computer", computer: {} });
      assert.equal(defined.status, 201, await defined.clone().text());
      const definition = ((await defined.json()) as { id: string; computer: object });
      assert.deepEqual(definition.computer, {});
      const create = await post("/v1/agents", { definition: definition.id, model: "test/echo" });
      assert.equal(create.status, 201, await create.clone().text());
      const { id, token: agentToken } = (await create.json()) as { id: string; token: string };
      // Without one, the deployment's containers are not this agent's: its computer route starts nothing.
      const plain = await post("/v1/agents", { model: "test/echo" });
      assert.equal(plain.status, 201, await plain.clone().text());
      const plainId = ((await plain.json()) as { id: string }).id;
      const refused = await post(`/experimental/agents/${plainId}/computer`, { provider: "container", op: "exec", argv: ["true"] });
      assert.equal(refused.status, 409, await refused.clone().text());
      assert.match(JSON.stringify(await refused.json()), /This agent has no computer: add `computer` to its definition/);
      assert.doesNotMatch(server.logs(), /containerName = /, "nothing started a container for it");
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
            const made = await fetch(`${server.url}/v1/agents`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ definition: definition.id, model: "test/echo", name }) });
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
  const offered: { text: string; tools: string[] }[] = [];
  const model = await listen(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), text = JSON.stringify(body.messages);
    offered.push({ text, tools: (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name) });
    const delta = (text.includes("FORK_CHILD") || text.includes("SHARE_CHILD") || text.includes("PLAIN_CHILD") || text.includes("NO_SPAWN")) || body.messages.at(-1).role === "tool" || text.includes("agent_notification")
      ? { role: "assistant", content: "done" }
      : { role: "assistant", tool_calls: [{ index: 0, id: "spawn-1", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ instructions: text.includes("REQUEST_PLAIN") ? "PLAIN_CHILD" : text.includes("REQUEST_SHARE") ? "SHARE_CHILD" : "FORK_CHILD", task: "Work on the computer", name: "worker", ...(text.includes("REQUEST_SHARE") || text.includes("REQUEST_PLAIN") ? {} : { computer: "fresh" }) }) } }] };
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

  // A default child uses the same native disk, provider setup and billing identity.
  const sharedLead = await api("/v1/agents", { body: { definition: definition.id, computerLimit: 1 } });
  await sh(sharedLead.id, "echo parent > /workspace/shared.txt");
  const sharedRun = await api(`/v1/agents/${sharedLead.id}/prompt`, { body: { text: "REQUEST_SHARE" } });
  let sharedChild: string | undefined;
  for (let i = 0; i < 100 && !sharedChild; i++) {
    const children = await api(`/v1/agents/${sharedLead.id}/children`);
    sharedChild = children.children?.[0]?.agentId ?? children.children?.[0]?.id;
    if (!sharedChild) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(sharedChild, JSON.stringify(sharedRun));
  const ownership = (await fixture.db.query("select * from computer_shares where agent=$1", [sharedChild])).rows;
  assert.equal(ownership[0]?.owner, sharedLead.id, JSON.stringify({ ownership, sharedChild, sharedLead }));
  const sharedRead = await sh(sharedChild, "cat /workspace/shared.txt");
  assert.match(sharedRead.stdout, /parent/, JSON.stringify(sharedRead));
  const [parentWork, childWork] = await Promise.all([
    sh(sharedLead.id, "touch /workspace/parent-ready; for i in $(seq 1 100); do test -f /workspace/child-ready && break; sleep 0.1; done; cat /workspace/child-ready"),
    sh(sharedChild, "for i in $(seq 1 100); do test -f /workspace/parent-ready && break; sleep 0.1; done; echo child > /workspace/child-ready"),
  ]);
  assert.equal(childWork.exitCode, 0);
  assert.match(parentWork.stdout, /child/);
  for (const op of ["sleep", "restore"]) {
    const denied = await computer(sharedChild, { op, ...(op === "restore" ? { name: "saved" } : {}) }, [400]);
    assert.match(JSON.stringify(denied), /belongs to your parent agent/);
  }
  await api(`/v1/agents/${sharedChild}`, { method: "DELETE" });
  assert.match((await sh(sharedLead.id, "cat /workspace/shared.txt")).stdout, /parent/);

  // Only an agent that has a computer is offered the tool: this deployment's containers alone give none.
  const toolsOf = async (marker: string, not = "\0") => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 100))) {
      const seen = offered.find(entry => entry.text.includes(marker) && !entry.text.includes(not));
      if (seen) return seen.tools;
    }
    throw new Error(`the model never saw ${marker}`);
  };
  const coderDefinition = await api("/v1/definitions", { body: { name: "Coder", computer: {} } });
  assert.deepEqual(coderDefinition.computer, {}, "computer: {} declares the default computer");
  const coder = await api("/v1/agents", { body: { definition: coderDefinition.id } });
  await api(`/v1/agents/${coder.id}/prompt`, { body: { text: "NO_SPAWN coder" } });
  assert.ok((await toolsOf("NO_SPAWN coder")).includes("computer"), "an agent whose definition declares a computer gets the tool");
  const plainDefinition = await api("/v1/definitions", { body: { name: "Messenger", builtins: ["agents"], delegate: { instructions: true } } });
  const messenger = await api("/v1/agents", { body: { definition: plainDefinition.id } });
  await api(`/v1/agents/${messenger.id}/prompt`, { body: { text: "NO_SPAWN messenger" } });
  const messengerTools = await toolsOf("NO_SPAWN messenger");
  assert.ok(messengerTools.includes("spawn_agent") && !messengerTools.includes("computer"), JSON.stringify(messengerTools));
  const noComputer = await computer(messenger.id, { op: "exec", command: "echo should-not-run" }, [409]);
  assert.match(JSON.stringify(noComputer), /This agent has no computer: add `computer` to its definition/);
  // Its children default to none, as with any parent that has no computer.
  const plainParent = await api("/v1/agents", { body: { definition: plainDefinition.id } });
  await api(`/v1/agents/${plainParent.id}/prompt`, { body: { text: "REQUEST_PLAIN" } });
  let plainChild: string | undefined;
  for (let i = 0; i < 100 && !plainChild; i++) {
    const children = await api(`/v1/agents/${plainParent.id}/children`);
    plainChild = children.children?.[0]?.agentId ?? children.children?.[0]?.id;
    if (!plainChild) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(plainChild);
  assert.deepEqual((await fixture.db.query("select owner from computer_shares where agent=$1", [plainChild])).rows, [{ owner: null }]);
  await computer(plainChild, { op: "exec", command: "echo should-not-run" }, [409]);
  assert.ok(!(await toolsOf("PLAIN_CHILD", "REQUEST_PLAIN")).includes("computer"), "a child without a computer is not offered the tool");
  assert.ok((await toolsOf("SHARE_CHILD", "REQUEST_SHARE")).includes("computer"), "a child sharing its parent's computer is");

  const capped = await api("/v1/agents", { body: { definition: definition.id, computerLimit: 1 } });
  await sh(capped.id, "echo root > /workspace/root.txt");
  await api(`/v1/agents/${capped.id}/prompt`, { body: { text: "start" } });
  let cappedChild: string | undefined;
  for (let i = 0; i < 100 && !cappedChild; i++) {
    const children = await api(`/v1/agents/${capped.id}/children`);
    cappedChild = children.children?.[0]?.agentId ?? children.children?.[0]?.id;
    if (!cappedChild) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(cappedChild);
  const capRefusal = await computer(cappedChild, { op: "exec", command: "echo should-not-run" }, [409]);
  assert.match(JSON.stringify(capRefusal), /This agent tree already runs its limit of machines/);
  assert.match((await sh(capped.id, "cat /workspace/root.txt")).stdout, /root/);

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
    networking: { type: "limited", allowedHosts: ["github.com"] },
    computer: { idleSeconds: 600, egress: [{ host: "github.com", auth: { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "write", metadata: "read" } } }] },
  } });
  assert.deepEqual(definition.computer.egress[0], { host: "github.com", auth: { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "write", metadata: "read" } }, scheme: "basic" });
  const agent = await api("/v1/agents", { body: { definition: definition.id } });

  const pushed = await sh(agent.id, "git clone -q https://github.com/acme/app.git /workspace/app && cd /workspace/app && git switch -qc camel/badge && echo badge >> README.md && git -c user.name=camel -c user.email=c@c commit -qam badge && git push -q origin camel/badge");
  assert.equal(pushed.exitCode, 0, JSON.stringify(pushed));
  // The wildcard gateway selects the GitHub grant, but blocks every other destination.
  const blocked = await sh(agent.id, "curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://example.com");
  assert.equal(blocked.exitCode, 0, JSON.stringify(blocked));
  assert.equal(blocked.stdout.trim(), "403");
  const fork = await api(`/v1/agents/${agent.id}/fork`, { body: {} });
  const forkBlocked = await sh(fork.id, "curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://example.com");
  assert.equal(forkBlocked.exitCode, 0, JSON.stringify(forkBlocked));
  assert.equal(forkBlocked.stdout.trim(), "403");
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
  const child = await api('/v1/agents', { definition: definition.id });
  await fixture.db.query('insert into computer_shares(tenant,agent,owner) values($1,$2,$3)', ['camelrun-proto-local', child.id, agent.id]);
  const readChild = (operation: object = { op: 'read', path: 'kept.txt' }) => fetch(fixture.url + `/experimental/agents/${child.id}/computer`, {
    method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'container', ...operation }),
  });
  const firstUse = await readChild({ op: 'write', path: 'kept.txt', content: 'still here' });
  assert.equal(firstUse.status, 200, await firstUse.text());
  // The DO's alarm puts it to sleep at the idle point; wait past it.
  await new Promise(resolve => setTimeout(resolve, 25_000));
  const resumedResponse = await readChild();
  assert.equal(resumedResponse.status, 200);
  const resumed = await resumedResponse.json() as any;
  assert.equal(resumed.content, "still here");
  assert.equal(resumed.computer?.restoredFrom, "sleep", JSON.stringify(resumed));
  // An idle alarm firing during exec must not queue the next exec behind that command.
  const long = computer({ op: "exec", command: "touch /workspace/in-flight; while ! test -f /workspace/release; do sleep 0.05; done", timeoutMs: 40_000 });
  await new Promise(resolve => setTimeout(resolve, 13_000));
  await computer({ op: "exec", command: "touch /workspace/release", timeoutMs: 5000 });
  assert.equal((await long).exitCode, 0);

  await computer({ op: 'sleep' });
  assert.match(await (await readChild()).text(), /parent's machine is stopped/);
  assert.equal((await computer({ op: 'read', path: 'kept.txt' })).content, 'still here', 'the owner can resume');
  await fixture.db.query('update agents set revoked=true where id=$1', [agent.id]);
  assert.match(await (await readChild()).text(), /parent's machine is stopped/);
});

test("jobs: one command in a container of its own, its files synced in and its outputs collected, then destroyed", {
  timeout: 600_000, skip: requireDocker ? false : unavailable,
}, async (t) => {
  assert.equal(unavailable, undefined, unavailable);
  const egressImage = await egressImageWithoutSocketMatch(t);
  if (egressImage) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
    t.after(() => { delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE; });
  }
  const fixture = await startFixture({ config: "wrangler.computers.test.jsonc", entrypoint: join(process.cwd(), "test/jobs-entry.ts") });
  t.after(async () => {
    const names = new Set([...fixture.worker.logs().matchAll(/containerName = (workerd-camelrun-proto-workers-computers-local-ContainerComputer-[a-f0-9]{64})/g)].map(match => match[1]));
    await fixture.stop();
    for (const name of names) for (const target of [name, `${name}-proxy`]) await run("docker", ["rm", "-f", target]).catch(() => {});
  });
  const call = async (path: string, body?: unknown, raw?: string) => {
    const response = await fetch(fixture.url + path, {
      method: raw !== undefined ? "PUT" : body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": raw !== undefined ? "text/plain" : "application/json" },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-4000)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const text = (value: { bytes: string }) => Buffer.from(value.bytes, "base64").toString();
  const definition = await call("/v1/definitions", { name: "Jobs payer" });
  const agent = await call("/v1/agents", { definition: definition.id });
  const tenant = "camelrun-proto-local";

  // Inline files, a payer, limits and outputs; one missing.
  const first = await call("/__test/jobs", {
    id: "inline-1", command: "cat src/hello.txt; mkdir -p $JOB_OUT/logs; wc -c < src/hello.txt > $JOB_OUT/logs/count.txt; echo oops >&2; exit 3",
    timeoutSeconds: 120, files: { "src/hello.txt": b64("hello from camel-sync"), [`${"deep/".repeat(25)}x.txt`]: b64("deep") },
    outputs: ["logs/count.txt", "missing.txt"], limits: { pids: 512 }, payer: { tenant, agent: agent.id }, saveSnapshot: "never-saved",
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.exitCode, 3);
  assert.equal(first.timedOut, false);
  assert.equal(text(first.stdout), "hello from camel-sync");
  assert.equal(text(first.stderr), "oops\n");
  assert.equal(text(first.outputs["logs/count.txt"]).trim(), "21");
  assert.deepEqual(first.missing, ["missing.txt"]);
  assert.equal(first.instance, "standard-1");
  assert.ok(["cgroup", "unenforced"].includes(first.pids));
  assert.equal(first.snapshot, undefined, "a failing job saves no snapshot");
  t.diagnostic(`job timings ${JSON.stringify(first.timings)}, pids ${first.pids}`);
  // Stopped and given back: no slot left, and the container time was charged to the payer.
  assert.equal((await fixture.db.query("select 1 from computer_slots where tenant=$1 and machine='job:inline-1'", [tenant])).rowCount, 0);
  let charged = 0;
  for (let i = 0; i < 50 && !charged; i++) {
    charged = (await fixture.db.query("select 1 from pi_usage_receipts where tenant=$1 and session_id=$2 and message->'_workersAuxiliary'->>'kind'='computer'", [tenant, agent.id])).rowCount ?? 0;
    if (!charged) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(charged, "the job's container time is a computer usage receipt for its payer");

  // A volume snapshot as the source, and a warm snapshot saved for the next job.
  const volume = await call("/v1/volumes", { name: "job-source" });
  await call(`/v1/volumes/${volume.id}/files/pkg/a.txt`, undefined, "from the volume");
  const snap = await call(`/v1/volumes/${volume.id}/snapshots`, { name: "for-job" });
  await call(`/v1/volumes/${volume.id}/files/pkg/a.txt`, undefined, "changed after the snapshot");
  const warm = await call("/__test/jobs", {
    id: "volume-1", payer: { tenant, agent: agent.id }, command: "cat pkg/a.txt; echo warm > /var/tmp/cache", timeoutSeconds: 120,
    volume: { tenant, volume: volume.id, snapshot: snap.id }, saveSnapshot: "warm-1",
  });
  assert.equal(warm.ok, true, JSON.stringify(warm));
  assert.equal(text(warm.stdout), "from the volume");
  assert.equal(warm.snapshot?.name, "warm-1");
  const resumed = await call("/__test/jobs", { id: "warm-2", payer: { tenant, agent: agent.id }, snapshot: warm.snapshot, command: "cat /var/tmp/cache; ls", timeoutSeconds: 120 });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(text(resumed.stdout), "warm\npkg\n", "a job from a snapshot starts with that job's disk");

  // A command past its timeout is killed; its outputs still come back.
  const slow = await call("/__test/jobs", { id: "slow-1", payer: { tenant, agent: agent.id }, command: "echo partial > $JOB_OUT/p.txt; sleep 60", timeoutSeconds: 3, outputs: ["p.txt"] });
  assert.equal(slow.ok, true, JSON.stringify(slow));
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, null);
  assert.equal(text(slow.outputs["p.txt"]), "partial\n");

  // stop() ends a running job.
  const running = call("/__test/jobs", { id: "stop-1", payer: { tenant, agent: agent.id }, command: "sleep 60", timeoutSeconds: 120 });
  let stopped = false;
  for (let i = 0; i < 120 && !stopped; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    stopped = (await call("/__test/jobs/stop", { id: "stop-1" })).stopped;
  }
  assert.ok(stopped);
  const ended = await running;
  assert.equal(ended.code, "stopped", JSON.stringify(ended));
});

test("workflows: children edit forks of a repo volume with their file tools, commit() lands them (one conflicts), and a job() tests the result", {
  timeout: 600_000, skip: requireDocker ? false : unavailable,
}, async (t) => {
  assert.equal(unavailable, undefined, unavailable);
  const egressImage = await egressImageWithoutSocketMatch(t);
  if (egressImage) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
    t.after(() => { delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE; });
  }
  // The children's model: "EDIT <path> <text>" makes one write tool call, then says it is done. The owner agent's: start
  // the workflow (SCRIPT) with its workflows builtin, then say which it started.
  let script = "";
  const textOf = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("\n");
  const model = createHttpServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const last = body.messages.at(-1), user = textOf(body.messages.filter((message: any) => message.role === "user").at(-1));
    const edit = /EDIT (\S+) (\S+)/.exec(user);
    const system = body.messages.filter((message: any) => message.role === "system").map(textOf).join("\n");
    const owner = !system.includes("You are a worker in a workflow") && user.startsWith("START");
    const delta = owner
      ? last.role === "tool" ? { role: "assistant", content: `STARTED ${textOf(last)}` }
        : { role: "assistant", tool_calls: [{ index: 0, id: "start-1", type: "function", function: { name: "workflow_start", arguments: JSON.stringify({ script, args: JSON.parse(user.slice(6)), budgetUsd: 5, name: "edit the repo" }) } }] }
      : last.role !== "tool" && edit
      ? { role: "assistant", tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: edit[1], content: edit[2] }) } }] }
      : { role: "assistant", content: `edited ${edit?.[1] ?? "nothing"}` };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "repo-model", object: "chat.completion.chunk", created: 1, model: "repo-model" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  t.after(() => { model.closeAllConnections(); return new Promise<void>(resolve => model.close(() => resolve())); });
  const fixture = await startFixture({ config: "wrangler.computers.test.jsonc", vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini", AGENT_WORKFLOW_TENANTS: "*",
    AGENT_WORKFLOW_CLASS_MODELS: JSON.stringify({ fast: "repo-fixture/repo-model", strong: "repo-fixture/repo-model", max: "repo-fixture/repo-model" }) } });
  t.after(async () => {
    const names = new Set([...fixture.worker.logs().matchAll(/containerName = (workerd-camelrun-proto-workers-computers-local-ContainerComputer-[a-f0-9]{64})/g)].map(match => match[1]));
    await fixture.stop();
    for (const name of names) for (const target of [name, `${name}-proxy`]) await run("docker", ["rm", "-f", target]).catch(() => {});
  });
  const call = async (path: string, body?: unknown, raw?: string, method?: string) => {
    const response = await fetch(fixture.url + path, {
      method: method ?? (raw !== undefined ? "PUT" : body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": raw !== undefined ? "text/plain" : "application/json" },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-4000)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  await call("/v1/providers/repo-fixture", { type: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, models: [{ id: "repo-model", contextWindow: 32768, pricing: { input: 1, output: 1 } }] }, undefined, "PUT");

  // A small repository: two source files and the test the job runs.
  const repo = await call("/v1/volumes", { name: "workflow-repo" });
  await call(`/v1/volumes/${repo.id}/files/src/a.txt`, undefined, "1");
  await call(`/v1/volumes/${repo.id}/files/src/b.txt`, undefined, "2");
  await call(`/v1/volumes/${repo.id}/files/check.sh`, undefined,
    'a=$(cat src/a.txt); b=$(cat src/b.txt); echo "a=$a b=$b" | tee "$JOB_OUT/report.txt"; test "$a" = one && test "$b" = two && echo PASS');
  script = `
    phase("edit");
    // Three workers fork the repo as it is now and edit it with their write tool; the third edits the file the first does.
    const [a, b, c] = await parallel([
      () => agent("EDIT /repo/src/a.txt one", { key: "edit:a", repo: args.repo, type: "worker" }),
      () => agent("EDIT /repo/src/b.txt two", { key: "edit:b", repo: args.repo, type: "worker" }),
      () => agent("EDIT /repo/src/a.txt uno", { key: "edit:c", repo: args.repo, type: "worker" }),
    ]);
    phase("commit");
    const landedA = await commit(a.fork, { key: "commit:a" });
    const landedB = await commit(b.fork, { key: "commit:b" });
    const landedC = await commit(c.fork, { key: "commit:c" });
    phase("test");
    const checked = await job({ key: "check", command: "bash check.sh", timeoutSeconds: 120, at: args.repo, outputs: ["report.txt"] });
    return { said: [a.text, b.text, c.text], landedA, landedB, landedC, checked };`;
  // An agent starts the workflow and owns it: it is the payer of the workflow's jobs.
  const owner = await call("/v1/agents", { model: "repo-fixture/repo-model", codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
  const run = await call(`/v1/agents/${owner.id}/prompt`, { text: `START ${JSON.stringify({ repo: repo.id })}` });
  let started: Record<string, any> = {};
  for (let i = 0; i < 300 && started.state !== "completed"; i++) { await new Promise(resolve => setTimeout(resolve, 200)); started = await call(`/v1/agents/${owner.id}/requests/${run.id}`); }
  const reply = String(started.outcome?.result?.reply ?? "");
  assert.match(reply, /^STARTED /, JSON.stringify(started.outcome));
  const created = { id: JSON.parse(reply.slice("STARTED ".length)).workflowId as string };
  let done: Record<string, any> = await call(`/v1/workflows/${created.id}`);
  assert.deepEqual(done.owner, { kind: "agent", id: owner.id });
  for (let i = 0; i < 600 && !["completed", "failed", "paused", "aborted", "budget_exhausted"].includes(done.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    done = await call(`/v1/workflows/${created.id}`);
  }
  assert.equal(done.status, "completed", JSON.stringify(done) + "\n" + JSON.stringify(await call(`/v1/workflows/${created.id}/items`)) + "\n" + fixture.worker.logs().slice(-4000));
  const { said, landedA, landedB, landedC, checked } = done.result;
  assert.deepEqual(said, ["edited /repo/src/a.txt", "edited /repo/src/b.txt", "edited /repo/src/a.txt"]);
  assert.equal(landedA.committed, true, JSON.stringify(landedA));
  assert.deepEqual(landedA.files, ["/src/a.txt"]);
  assert.equal(landedB.committed, true, JSON.stringify(landedB));
  assert.deepEqual(landedB.files, ["/src/b.txt"]);
  // The third fork started from the a.txt the first commit changed: nothing of it is written.
  assert.equal(landedC.committed, false, JSON.stringify(landedC));
  assert.deepEqual(landedC.conflicts.map((conflict: { path: string }) => conflict.path), ["/src/a.txt"]);
  // The base holds both commits and not the conflicting edit; the job ran against it.
  assert.equal(await call(`/v1/volumes/${repo.id}/files/src/a.txt`), "one");
  assert.equal(await call(`/v1/volumes/${repo.id}/files/src/b.txt`), "two");
  assert.equal(checked.exitCode, 0, JSON.stringify(checked));
  assert.match(checked.stdout.tail, /a=one b=two\nPASS/);
  // Its streams and outputs are kept whole in the workflow's volume.
  assert.equal((await call(`/v1/volumes/${checked.volume}/files${checked.outputs["report.txt"].path}`)).trim(), "a=one b=two");
  assert.match(await call(`/v1/volumes/${checked.volume}/files${checked.stdout.path}`), /PASS/);
  const items = (await call(`/v1/workflows/${created.id}/items`)).items as { key: string; kind: string; status: string }[];
  assert.deepEqual(items.map(item => [item.key, item.kind, item.status]).sort(),
    [["check", "job", "done"], ["commit:a", "commit", "done"], ["commit:b", "commit", "done"], ["commit:c", "commit", "done"], ["edit:a", "agent", "done"], ["edit:b", "agent", "done"], ["edit:c", "agent", "done"]]);
  // The job's computer slot was given back when it ended.
  assert.equal((await fixture.db.query("select 1 from computer_slots where tenant=$1 and machine like 'job:wf-%' and expires_at > $2", ["camelrun-proto-local", Date.now()])).rowCount, 0);
  // Its container time was metered once, to the owner agent, under the job's own receipt, and counts in the workflow's ledger.
  let receipts: any[] = [];
  for (let i = 0; i < 50 && !receipts.length; i++) {
    receipts = (await fixture.db.query("select message->'_workersAuxiliary' as receipt from pi_usage_receipts where tenant=$1 and session_id=$2 and message->'_workersAuxiliary'->>'kind'='computer'", ["camelrun-proto-local", owner.id])).rows;
    if (!receipts.length) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(receipts.length, 1, JSON.stringify(receipts));
  assert.match(receipts[0].receipt.callId, /^computer:job:wf-[0-9a-f]{40}$/);
  const jobItem = items.find(item => item.key === "check") as unknown as { costUsd?: number };
  assert.ok(jobItem.costUsd !== undefined && Math.abs(jobItem.costUsd - receipts[0].receipt.costUsd) < 1e-9, JSON.stringify({ jobItem, receipts }));
  assert.ok(done.spent.usd >= jobItem.costUsd!, JSON.stringify(done.spent));

  // The workflow ended: its children's forks are deleted, which releases their pins on the repo's content.
  const forks = (items as unknown as { kind: string; result?: { fork?: { volume: string } } }[]).filter(item => item.kind === "agent").map(item => item.result!.fork!.volume);
  assert.equal(forks.length, 3);
  for (const fork of forks) {
    let status = 0;
    for (let i = 0; i < 50 && status !== 404; i++) {
      status = (await fetch(`${fixture.url}/v1/volumes/${fork}`, { headers: { authorization: `Bearer ${fixture.token}` } })).status;
      if (status !== 404) await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(status, 404, `fork ${fork} is deleted`);
  }
  assert.equal(await call(`/v1/volumes/${repo.id}/files/src/a.txt`), "one", "the base keeps its content");

  // A workflow an API key started has no owner agent: its job() runs too, paid by its tenant (the next test has the money).
  const keyStarted = await call("/v1/workflows", { script: `return await job({ key: "j", command: "true", timeoutSeconds: 30 });`, budget: { usd: 1 } });
  let keyDone: Record<string, any> = keyStarted;
  for (let i = 0; i < 600 && !["completed", "failed", "paused"].includes(keyDone.status); i++) { await new Promise(resolve => setTimeout(resolve, 250)); keyDone = await call(`/v1/workflows/${keyStarted.id}`); }
  assert.equal(keyDone.status, "completed", JSON.stringify(keyDone));
  assert.equal(keyDone.result?.exitCode, 0, JSON.stringify(keyDone.result));
});

test("workflows: an API-started workflow's job is paid by its tenant under the workflow, once across a rerun; no credit pauses it", {
  timeout: 600_000, skip: requireDocker ? false : unavailable,
}, async (t) => {
  assert.equal(unavailable, undefined, unavailable);
  const egressImage = await egressImageWithoutSocketMatch(t);
  if (egressImage) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
    t.after(() => { delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE; });
  }
  const tenant = "camelrun-proto-local", poor = "camelrun-proto-poor";
  const tokens = { [tenant]: "local-integration-only-token-with-at-least-32-characters", [poor]: "art_poor-tenant-fixture-token-with-32-characters" };
  const fixture = await startFixture({ config: "wrangler.computers.test.jsonc", entrypoint: join(process.cwd(), "test/jobs-entry.ts"),
    tenants: [{ id: tenant, token: tokens[tenant] }, { id: poor, token: tokens[poor], seedCredit: false }], vars: { AGENT_WORKFLOW_TENANTS: "*" } });
  t.after(async () => {
    const names = new Set([...fixture.worker.logs().matchAll(/containerName = (workerd-camelrun-proto-workers-computers-local-ContainerComputer-[a-f0-9]{64})/g)].map(match => match[1]));
    await fixture.stop();
    for (const name of names) for (const target of [name, `${name}-proxy`]) await run("docker", ["rm", "-f", target]).catch(() => {});
  });
  const call = async (path: string, body?: unknown, as = tenant) => {
    const response = await fetch(fixture.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${tokens[as]}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-4000)}`);
    return JSON.parse(text);
  };
  const until = async <T>(read: () => Promise<T | false | undefined>, what: string) => {
    for (let i = 0; i < 600; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
    throw new Error(`Timed out: ${what}\n${fixture.worker.logs().slice(-4000)}`);
  };
  const script = `return await job({ key: "check", command: "echo paid > $JOB_OUT/o.txt; echo ran", timeoutSeconds: 60, outputs: ["o.txt"] });`;

  // Started with an API key: no owner agent. Its tenant pays, and the workflow completes.
  const started = await call("/v1/workflows", { script, budget: { usd: 1 } });
  assert.equal(started.owner, undefined, "an API start has no owner agent");
  const done = await until(async () => { const value = await call(`/v1/workflows/${started.id}`); return ["completed", "failed", "paused"].includes(value.status) && value; }, "the API-started workflow");
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.result.exitCode, 0, JSON.stringify(done.result));
  assert.ok(done.spent.usd > 0, `the job's container time counts in the workflow's ledger: ${JSON.stringify(done.spent)}`);
  // One receipt, under the workflow; the usage rows and details carry it with the workflow as agent and root.
  const receipts = async () => (await fixture.db.query("select entry_id, message from pi_usage_receipts where tenant=$1 and session_id=$2 and message->'_workersAuxiliary'->>'kind'='computer'", [tenant, started.id])).rows;
  await until(async () => (await receipts()).length > 0, "the job's computer receipt");
  const first = await receipts();
  assert.equal(first.length, 1, JSON.stringify(first));
  const usage = async () => Number((await fixture.db.query("select coalesce(sum(cost),0) as cost from usage where tenant=$1 and model like 'computer:%'", [tenant])).rows[0].cost);
  const charged = await usage();
  assert.ok(charged > 0, "the tenant's usage counts the job's container time");
  const details = (await fixture.db.query("select agent, root_agent, end_user from usage_details where tenant=$1 and model like 'computer:%'", [tenant])).rows;
  assert.deepEqual(details, [{ agent: started.id, root_agent: started.id, end_user: null }], "usage shows the workflow, and no end user");

  // The same job delivered again (a restart runs it again under its key:attempt): no second charge.
  const id = `wf-${createHash("sha256").update(`${started.id}\ncheck\n1`).digest("hex").slice(0, 40)}`;
  const again = await call("/__test/jobs", { id, command: "echo ran", timeoutSeconds: 60, payer: { tenant, agent: started.id, kind: "workflow" } });
  assert.equal(again.ok, true, JSON.stringify(again));
  await new Promise(resolve => setTimeout(resolve, 2_000));
  assert.deepEqual((await receipts()).map(row => row.entry_id), first.map(row => row.entry_id), "the rerun's charge is the same receipt");
  assert.equal(await usage(), charged, "and the usage is counted once");

  // A tenant with no credit: the job is refused before any compute, and the workflow pauses for its payer.
  const broke = await call("/v1/workflows", { script, budget: { usd: 1 } }, poor);
  const paused = await until(async () => { const value = await call(`/v1/workflows/${broke.id}`, undefined, poor); return value.status !== "running" && value; }, "the refused workflow");
  assert.equal(paused.status, "paused", JSON.stringify(paused));
  assert.equal(paused.pauseReason, "payer_exhausted", JSON.stringify(paused));
  assert.equal((await fixture.db.query("select 1 from pi_usage_receipts where tenant=$1", [poor])).rowCount, 0, "nothing was charged");
  assert.equal((await fixture.db.query("select 1 from computer_slots where tenant=$1 and expires_at>$2", [poor, Date.now()])).rowCount, 0, "and no computer slot is held");
});

test("the jobs builtin: an agent runs one command on a volume with job_run, billed as its own computer time", {
  timeout: 600_000, skip: requireDocker ? false : unavailable,
}, async (t) => {
  assert.equal(unavailable, undefined, unavailable);
  const egressImage = await egressImageWithoutSocketMatch(t);
  if (egressImage) {
    process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE = egressImage;
    t.after(() => { delete process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE; });
  }
  // The agent's model: "RUN <json>" makes one job_run call with those arguments, then answers with what it returned.
  const textOf = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("\n");
  const tools: string[][] = [];
  const model = createHttpServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    tools.push((body.tools ?? []).map((tool: any) => tool.function?.name));
    const last = body.messages.at(-1), user = textOf(body.messages.filter((message: any) => message.role === "user").at(-1));
    const delta = last.role === "tool" ? { role: "assistant", content: `RAN ${textOf(last)}` }
      : { role: "assistant", tool_calls: [{ index: 0, id: "job-1", type: "function", function: { name: "job_run", arguments: user.slice(4) } }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "job-model", object: "chat.completion.chunk", created: 1, model: "job-model" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  t.after(() => { model.closeAllConnections(); return new Promise<void>(resolve => model.close(() => resolve())); });
  const fixture = await startFixture({ config: "wrangler.computers.test.jsonc", vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini", AGENT_WORKFLOW_TENANTS: "*" } });
  t.after(async () => {
    const names = new Set([...fixture.worker.logs().matchAll(/containerName = (workerd-camelrun-proto-workers-computers-local-ContainerComputer-[a-f0-9]{64})/g)].map(match => match[1]));
    await fixture.stop();
    for (const name of names) for (const target of [name, `${name}-proxy`]) await run("docker", ["rm", "-f", target]).catch(() => {});
  });
  const call = async (path: string, body?: unknown, raw?: string, method?: string) => {
    const response = await fetch(fixture.url + path, {
      method: method ?? (raw !== undefined ? "PUT" : body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${fixture.token}`, "content-type": raw !== undefined ? "text/plain" : "application/json" },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-4000)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  await call("/v1/providers/job-fixture", { type: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, models: [{ id: "job-model", contextWindow: 32768, pricing: { input: 1, output: 1 } }] }, undefined, "PUT");
  const repo = await call("/v1/volumes", { name: "job-run-repo" });
  await call(`/v1/volumes/${repo.id}/files/check.sh`, undefined, 'echo "files: $(ls)"; echo checked > "$JOB_OUT/report.txt"; exit 3');
  // An ordinary agent (no delegate settings): it has job_run, not the workflows builtin.
  const agent = await call("/v1/agents", { model: "job-fixture/job-model", codeMode: false, fileTools: false });
  const prompt = await call(`/v1/agents/${agent.id}/prompt`, { text: `RUN ${JSON.stringify({ command: "bash check.sh", at: repo.id, outputs: ["report.txt"], timeoutSeconds: 120 })}` });
  let record: Record<string, any> = {};
  for (let i = 0; i < 900 && record.state !== "completed"; i++) { await new Promise(resolve => setTimeout(resolve, 200)); record = await call(`/v1/agents/${agent.id}/requests/${prompt.id}`); }
  const reply = String(record.outcome?.result?.reply ?? "");
  assert.match(reply, /^RAN /, JSON.stringify(record.outcome) + "\n" + fixture.worker.logs().slice(-4000));
  const ran = JSON.parse(reply.slice(4));
  assert.equal(ran.ok, true, reply);
  assert.equal(ran.exitCode, 3);
  assert.equal(ran.stdout, "files: check.sh\n");
  assert.deepEqual(ran.outputs, { "report.txt": "checked\n" });
  assert.ok(tools[0]!.includes("job_run") && !tools[0]!.includes("workflow_start"), JSON.stringify(tools[0]));
  // Billed once, to the agent, as computer time under the job's own receipt; its slot given back.
  let receipts: any[] = [];
  for (let i = 0; i < 50 && !receipts.length; i++) {
    receipts = (await fixture.db.query("select message->'_workersAuxiliary' as receipt from pi_usage_receipts where tenant=$1 and session_id=$2 and message->'_workersAuxiliary'->>'kind'='computer'", ["camelrun-proto-local", agent.id])).rows;
    if (!receipts.length) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(receipts.length, 1, JSON.stringify(receipts));
  assert.match(receipts[0].receipt.callId, /^computer:job:agent-[0-9a-f]{40}$/);
  assert.equal((await fixture.db.query("select 1 from computer_slots where tenant=$1 and machine like 'job:agent-%' and expires_at > $2", ["camelrun-proto-local", Date.now()])).rowCount, 0);
});
