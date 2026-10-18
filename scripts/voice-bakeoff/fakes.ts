import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { Outbound } from "../../src/outbound.ts";
import { fakeAssemblyAI, fakeDeepgram, fakeFlux, fakeSoniox } from "../../tests/speech-provider-fakes.ts";
import { fakeRealtime } from "../../tests/voice-fakes.ts";
import type { BakeoffOptions } from "./run.ts";

/**
 * A dry run's providers: every one faked on one local server (the tests' fakes of each wire protocol), answering each
 * clip with its own words. It checks the bake-off's plumbing end to end without keys or calls (CI runs it); its numbers
 * measure this machine, not any provider.
 */
export async function fakeProviders(heard: () => string): Promise<{ options: Partial<BakeoffOptions>; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/audio/transcriptions")) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: heard(), usage: { type: "duration", seconds: 1 } })); return; }
    if (req.method === "POST") {
      // Any provider's speech: 0.5 s of tone, in chunks.
      res.writeHead(200, { "Content-Type": "audio/pcm" });
      for (let i = 0; i < 5; i++) { res.write(Buffer.alloc(4_800, 3)); await new Promise(resolve => setTimeout(resolve, 2)); }
      res.end();
      return;
    }
    res.writeHead(404).end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // One server, many WebSocket protocols: each upgrade goes to the fake its path names.
  const route = (path: (url: string) => boolean) => {
    const sockets = new WebSocketServer({ noServer: true });
    const proxy = Object.assign(Object.create(server), { on: (event: string, handler: (...args: any[]) => void) => {
      if (event !== "upgrade") return server.on(event, handler);
      return server.on("upgrade", (req, socket, head) => { if (path(req.url ?? "")) handler(req, socket, head); });
    } });
    return { server: proxy, sockets };
  };
  const nova = route(url => url.startsWith("/v1/listen"));
  fakeDeepgram(nova.server, nova.sockets, heard);
  const flux = route(url => url.startsWith("/v2/listen"));
  fakeFlux(flux.server, flux.sockets, heard);
  const soniox = route(url => url.startsWith("/soniox"));
  fakeSoniox(soniox.server, soniox.sockets, heard);
  const assemblyai = route(url => url.startsWith("/v3/ws"));
  fakeAssemblyAI(assemblyai.server, assemblyai.sockets, heard);
  const realtime = route(url => url.startsWith("/v1/realtime"));
  fakeRealtime(realtime.server, heard);
  return {
    options: {
      keys: { openai: "sk-fake", deepgram: "dg-fake", soniox: "soniox-key", assemblyai: "aai-fake", elevenlabs: "xi-fake", cartesia: "car-fake" },
      voices: { cartesia: "fake-voice" },
      stt_endpoints: { openai: `${base}/v1`, deepgram: base, soniox: `${base.replace(/^http/, "ws")}/soniox`, assemblyai: base },
      tts_endpoints: { openai: `${base}/v1`, elevenlabs: base, cartesia: base, deepgram: base, openaiBatch: `${base}/v1` },
      outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }),
    },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
