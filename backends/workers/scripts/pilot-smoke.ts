#!/usr/bin/env node
// Run with Node 22 --experimental-strip-types. Supply a throwaway tenant key
// on stdin; credentials are never written to reports or command arguments.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Agents } from "../../../clients/node.ts";
import { PNG } from "../../../tests/file-fixtures.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const fakeProvider = (baseUrl: string) => ({
  type: "openai-completions", baseUrl: baseUrl.replace(/\/$/, "") + "/v1",
  models: [{ id: "deterministic", contextWindow: 32768, maxOutputTokens: 1024, input: ["text", "image"], pricing: { input: 1, output: 1 }, compat: { supportsUsageInStreaming: true } }],
});

export async function runSmoke(options: { apiKey: string; baseUrl: string; fakeUrl: string; idleMs?: number; python?: string }) {
  const { apiKey, baseUrl, fakeUrl } = options;
  assert.equal(new URL(baseUrl).hostname, "run-pilot.camelai.dev", "Smoke tests target only the pilot");
  const checks: Array<{ name: string; ms: number }> = [];
  const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(baseUrl + path, { method, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Pilot request ${method} ${path} returned ${response.status}`);
    return await response.json() as any;
  };
  const check = async (name: string, work: () => Promise<void>) => {
    const started = Date.now(); await work();
    const result = { name, ms: Date.now() - started }; checks.push(result);
    console.log(JSON.stringify({ check: name, status: "pass", ms: result.ms }));
  };
  let sockets = 0;
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets++; }
  };
  const agents = new Agents({ url: baseUrl, apiKey, pollMs: 200 });
  const handles: Awaited<ReturnType<Agents["upsert"]>>[] = [];
  let idle: { agentId: string; startedAt: string; endedAt: string; elapsedMs: number; frames: number } | undefined;
  try {
    await request("/v1/providers/pilot-fake", fakeProvider(fakeUrl), "PUT");
    const make = async (key: string, config = {}) => {
      const handle = await agents.upsert(`pilot-smoke-${key}`, { model: "pilot-fake/deterministic", ...config });
      handles.push(handle); return handle;
    };
    const agent = await make("main", { builtins: ["ask_human"] });
    await check("typescript-create-message-history", async () => {
      assert.equal((await agent.run("pilot:hello")).text, "Echo: pilot:hello");
      assert.match(JSON.stringify(await agent.history()), /pilot:hello/);
    });
    await check("typescript-websocket-stream", async () => {
      const before = sockets;
      // The parity backend deliberately selects SSE when both are offered.
      // Exercise the SDK's WebSocket path by explicitly offering only it.
      const websocketFetch: typeof fetch = (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (new URL(target).pathname.endsWith("/events")) headers.set("accept", "application/vnd.camelrun.events+json");
        return fetch(input, { ...init, headers });
      };
      const streamingClient = new Agents({ url: baseUrl, apiKey, pollMs: 200, fetch: websocketFetch });
      try {
        const streamingAgent = await streamingClient.get(agent.id);
        const parts: string[] = [];
        const stream = streamingAgent.stream("pilot:stream");
        for await (const part of stream) if (part.type === "text") parts.push(part.text);
        assert.equal(parts.join(""), "Echo: pilot:stream");
        assert.equal((await stream.result()).status, "completed");
        assert.ok(sockets > before, "The SDK opened a real WebSocket");
      } finally { await streamingClient.close(); }
    });
    await check("human-input", async () => {
      const human = await agent.run("pilot:human");
      assert.equal(human.status, "input_required"); assert.equal(human.inputs.length, 1);
      const resumed = await human.inputs[0].answer("approved");
      assert.equal(resumed.status, "completed"); assert.match(resumed.text, /approved/);
    });
    await check("schedule-alarm", async () => {
      await request(`/v1/agents/${agent.id}/schedules`, { text: "pilot:scheduled", inSeconds: 1 });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (JSON.stringify(await agent.history()).includes("Echo: pilot:scheduled")) return;
        await delay(500);
      }
      throw new Error("Scheduled turn did not complete");
    });
    await check("files-roundtrip", async () => {
      await agent.files.upload("/workspace/pilot.txt", "pilot-file-content", { contentType: "text/plain" });
      assert.equal(new TextDecoder().decode((await agent.files.download("/workspace/pilot.txt")).data), "pilot-file-content");
    });
    await check("image-attachment-streaming-and-history", async () => {
      const result = await agent.run("pilot:images", { files: [{ name: "pilot.png", data: PNG, contentType: "image/png" }] });
      assert.equal(result.text, `Images received: 1; inline: 1; markers: 0; bytes: ${PNG.length}`);
      const history = JSON.stringify(await agent.history());
      assert.ok(!history.includes(PNG.toString("base64")), "Image bytes are absent from journal history");
      assert.match(history, /pilot.png/);
    });
    await check("codemode-remote-sandbox", async () => {
      const code = await make("code");
      const result = await code.run("pilot:code");
      assert.equal(result.status, "completed"); assert.match(result.text, /pilot-codemode-ok/);
      assert.equal(new TextDecoder().decode((await code.files.download("/workspace/pilot-code.txt")).data), "pilot-codemode-ok");
    });
    await check("delegation", async () => {
      const parent = await make("parent", { codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } });
      const run = await parent.run("pilot:delegate");
      assert.equal(run.status, "completed"); assert.match(run.text, /pilot:child/);
      assert.ok(run.toolCalls.some(call => call.tool === "delegate"), "Model executed the delegation tool");
    });
    await check("python-sdk-message-and-stream", async () => {
      const script = new URL("./pilot-smoke.py", import.meta.url);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(options.python ?? "python3", [script.pathname], { env: { ...process.env, PILOT_URL: baseUrl, PYTHONPATH: new URL("../../../clients/python", import.meta.url).pathname }, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        child.stdout.on("data", () => {});
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        child.stdin.end(apiKey);
        child.on("error", () => reject(new Error("Python smoke process could not start")));
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Python SDK smoke failed (${code}); ${stderr.replaceAll(apiKey, "[redacted]").slice(-1500)}`)));
      });
    });
    await check("idle-websocket-reconnect", async () => {
      const path = `/v1/agents/${agent.id}/events`;
      const response = await fetch(baseUrl + path, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/vnd.camelrun.events+json" } });
      assert.equal(response.status, 200);
      const selected = await response.json() as { transport: string; protocol: string; url: string };
      assert.equal(selected.transport, "websocket");
      const endpoint = new URL(selected.url, baseUrl); endpoint.protocol = "wss:";
      const socket = new OriginalWebSocket(endpoint, [selected.protocol, `bearer.${Buffer.from(apiKey).toString("base64url")}`]);
      let frames = 0; socket.addEventListener("message", () => frames++);
      try {
        await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Idle WebSocket failed to open")), { once: true }); });
        await delay(1000); const beforeFrames = frames; const start = Date.now();
        const startedAt = new Date(start).toISOString();
        await delay(options.idleMs ?? 90000);
        idle = { agentId: agent.id, startedAt, endedAt: new Date().toISOString(), elapsedMs: Date.now() - start, frames: frames - beforeFrames };
        assert.equal(socket.readyState, 1, "Idle WebSocket stayed open");
        assert.equal(idle.frames, 0, "No keepalive frames woke the object while idle");
        assert.equal((await agent.run("pilot:wake")).text, "Echo: pilot:wake");
      } finally { socket.close(); }
    });
    return { startedAt: new Date().toISOString(), checks, websocketConnections: sockets, idle, note: "Idle socket lifetime is observed here; use Cloudflare DO duration metrics for billing proof." };
  } finally {
    await agents.close();
    for (const handle of handles.reverse()) await handle.delete().catch(() => {});
    await request("/v1/providers/pilot-fake", undefined, "DELETE").catch(() => {});
    globalThis.WebSocket = OriginalWebSocket;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ""; for await (const chunk of process.stdin) input += chunk;
  const apiKey = input.trim();
  assert.ok(apiKey, "Supply the throwaway tenant key through stdin");
  try {
    console.log(JSON.stringify(await runSmoke({ apiKey, baseUrl: process.env.PILOT_URL ?? "https://run-pilot.camelai.dev", fakeUrl: process.env.PILOT_FAKE_URL!, python: process.env.PILOT_PYTHON }), null, 2));
  } catch (error) {
    console.error(String(error).replaceAll(apiKey, "[redacted]")); process.exitCode = 1;
  }
}
