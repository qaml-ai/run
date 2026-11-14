import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { HttpError } from "../src/http.ts";
import type { VoiceCallsOptions } from "../src/voice-calls.ts";
import type { VoiceCredit } from "../src/voice-sessions.ts";

export async function fakeOpenAICalls(t: TestContext) {
  const answer = "v=0\r\ns=answer\r\n";
  const offers: { sdp: string; type: string; session: any }[] = [];
  const hangups: string[] = [];
  const connections: { url: string; auth?: string }[] = [];
  const sent: { id: string; event: any }[] = [];
  const peers = new Map<string, WebSocket>();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/v1/realtime/calls") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers["content-type"]! } }).formData();
        const offer = form.get("sdp") as File;
        offers.push({ sdp: await offer.text(), type: offer.type, session: JSON.parse(String(form.get("session"))) });
        res.writeHead(201, { Location: `/v1/realtime/calls/call_${offers.length}` }).end(answer);
        return;
      }
      const id = /^\/v1\/realtime\/calls\/([^/]+)\/hangup$/.exec(req.url ?? "")?.[1];
      if (req.method === "POST" && id) {
        hangups.push(id);
        peers.get(id)?.close(1000);
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  const sockets = new WebSocketServer({ server, path: "/v1/realtime" });
  sockets.on("connection", (ws, req) => {
    const url = req.url!;
    const id = new URL(url, "http://localhost").searchParams.get("call_id")!;
    connections.push({ url, auth: req.headers.authorization });
    peers.set(id, ws);
    ws.on("message", data => sent.push({ id, event: JSON.parse(String(data)) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.close(() => resolve());
  }));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    answer, offers, hangups, connections,
    events: (id: string) => sent.filter(entry => entry.id === id).map(entry => entry.event),
    disconnect: (id: string, reason = "test error") => peers.get(id)!.close(1011, reason),
    script: (id: string) => (...events: Record<string, unknown>[]) => {
      for (const event of events) peers.get(id)!.send(JSON.stringify(event));
    },
  };
}

export function fakeCredit() {
  const log: unknown[][] = [];
  const refuse = { create: false, hold: false };
  const credit: VoiceCredit = {
    async refusal(_tenant, subject, bucket) {
      log.push(["refusal", subject, bucket]);
      if (refuse.create) return { reason: "balance", message: "No credit left" };
    },
    async hold(_tenant, subject, bucket, usd, kind, metadata) {
      log.push(["hold", subject, bucket, usd, kind, metadata]);
      if (refuse.hold) throw new HttpError(402, "No credit left", "END_USER_CREDIT", { reason: "balance" });
      return {
        settle: async actual => { log.push(["settle", actual]); },
        release: async () => { log.push(["release"]); },
      };
    },
  };
  return { credit, log, refuse };
}

type Request = Parameters<VoiceCallsOptions["submitStreaming"]>[2];

export function fakeSubmit(replies: ({ text: string; delay?: number } | "hang" | "missing")[] = []) {
  const requests: Request[] = [];
  const submit: VoiceCallsOptions["submitStreaming"] = async function* (_agent, _tenant, request, signal) {
    requests.push(request);
    const reply = replies[requests.length - 1] ?? { text: "It's noon." };
    if (reply === "missing") throw new HttpError(404, "End user not found", "END_USER_NOT_FOUND");
    if (reply === "hang") await sleep(600_000, undefined, { signal });
    else {
      if (reply.delay) await sleep(reply.delay, undefined, { signal });
      yield reply.text;
    }
  };
  return { requests, submit };
}

export async function fakeElevenLabs(t: TestContext, onRequest?: (path: string) => void) {
  const webhooks: any[] = [], tools: any[] = [], agents: any[] = [], signed: URLSearchParams[] = [];
  const conversations: string[] = [];
  const reports = new Map<string, { status?: string; metadata?: { call_duration_secs?: number; termination_reason?: string } } | 404 | 500>();
  const webhookSecret = "fixture-webhook-secret";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      onRequest?.(url.pathname);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      let result;
      if (req.method === "POST" && url.pathname === "/v1/workspace/webhooks") {
        webhooks.push(body);
        result = { webhook_id: "wh_1", webhook_secret: webhookSecret };
      } else if (req.method === "POST" && url.pathname === "/v1/convai/tools") {
        tools.push(body.tool_config);
        result = { id: `tool_${tools.length}` };
      } else if (req.method === "POST" && url.pathname === "/v1/convai/agents/create") {
        agents.push(body);
        result = { agent_id: `agent_${agents.length}` };
      } else if (req.method === "GET" && url.pathname === "/v1/convai/conversation/get-signed-url") {
        signed.push(url.searchParams);
        result = { signed_url: `wss://fake/convai?agent_id=${url.searchParams.get("agent_id")}&conversation_signature=sig&conversation_id=conv_${signed.length}` };
      } else if (req.method === "GET" && url.pathname.startsWith("/v1/convai/conversations/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/convai/conversations/".length));
        conversations.push(id);
        const report = reports.get(id) ?? 404;
        if (typeof report === "number") {
          res.writeHead(report).end();
          return;
        }
        result = report;
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, webhooks, tools, agents, signed, webhookSecret, conversations, reports };
}

export function sign(secret: string, body: string, now = Date.now()) {
  const t = Math.floor(now / 1000);
  const digest = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v0=${digest}`;
}
