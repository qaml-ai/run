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

export function fakeCredit(balance = Infinity) {
  const log: unknown[][] = [];
  const refuse = { create: false };
  const keys = new Set<string>();
  const credit: VoiceCredit = {
    async refusal(_tenant, endUser, bucket) {
      log.push(["refusal", endUser, bucket]);
      if (refuse.create || balance <= 0) return { endUser, bucket, reason: "balance", message: "No credit left" };
    },
    async debit(_tenant, subject, bucket, usd, key, metadata) {
      if (keys.has(key)) return;
      keys.add(key);
      balance -= usd;
      log.push(["debit", subject, bucket, usd, key, metadata]);
    },
  };
  return { credit, log, refuse, balance: () => balance };
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
