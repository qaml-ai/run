import { createCipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createSocket, type RemoteInfo } from "node:dgram";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

type T = { after(fn: () => Promise<void> | void): void };

/** A self-signed certificate for 127.0.0.1, made with openssl (the voice gateway is wss only). */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "fake-voice-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

type Call = {
  ws: WebSocket; identify: { server_id: string; user_id: string; session_id: string; token: string; max_dave_protocol_version: number };
  ssrc: number; key: Buffer; client?: RemoteInfo; nonce: number; sequence: number; timestamp: number;
  /** SSRCs whose Speaking (op 5) this call was sent. */
  announced: Set<number>;
};

/**
 * A Discord voice server for tests, as far as a listening bot needs one: the voice gateway (v8, JSON over wss) answers
 * Identify with Ready, does UDP IP discovery, picks aead_aes256_gcm_rtpsize and no DAVE, acknowledges heartbeats and
 * Resume, and tells of the call's members (Clients Connect, Client Disconnect). A test makes people speak (Speaking,
 * then RTP packets of Opus encrypted as Discord does), closes sockets with Discord's close codes, and refuses tokens.
 */
export async function fakeDiscordVoice(t: T) {
  // The client checks the voice server's certificate, which this one cannot have from a CA.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const server = createServer(certificate());
  const wss = new WebSocketServer({ server });
  const udp = createSocket("udp4");
  const calls: Call[] = [];
  const identifies: Call["identify"][] = [];
  const resumes: unknown[] = [];
  const refused = new Set<string>();
  let members: string[] = [];
  let nextSsrc = 1000;
  const send = (ws: WebSocket, op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));

  wss.on("connection", ws => {
    send(ws, 8, { heartbeat_interval: 1_000 });
    ws.on("message", raw => {
      const { op, d } = JSON.parse(String(raw));
      if (op === 0) {
        identifies.push(d);
        if (refused.has(d.token)) { ws.close(4004, "Authentication failed"); return; }
        const call: Call = { ws, identify: d, ssrc: nextSsrc++, key: randomBytes(32), nonce: 0, sequence: 0, timestamp: 0, announced: new Set() };
        calls.push(call);
        send(ws, 2, { ssrc: call.ssrc, ip: "127.0.0.1", port: (udp.address()).port, modes: ["aead_aes256_gcm_rtpsize"] });
      } else if (op === 1) {
        const call = calls.find(entry => entry.ws === ws);
        if (!call) return;
        send(ws, 4, { mode: d.data.mode, secret_key: [...call.key], dave_protocol_version: 0 });
        if (members.length) send(ws, 11, { user_ids: members });
      } else if (op === 3) send(ws, 6, { t: d.t });
      else if (op === 7) {
        // The call goes on over the new socket.
        resumes.push(d);
        const call = calls.filter(entry => entry.identify.session_id === d.session_id).at(-1);
        if (call) call.ws = ws;
        send(ws, 9, null);
      }
    });
  });
  udp.on("message", (message, from) => {
    if (message.length !== 74 || message.readUInt16BE(0) !== 1) return;
    const call = calls.find(entry => entry.ssrc === message.readUInt32BE(4));
    if (call) call.client = from;
    const answer = Buffer.alloc(74);
    answer.writeUInt16BE(2, 0);
    answer.writeUInt16BE(70, 2);
    answer.writeUInt32BE(message.readUInt32BE(4), 4);
    answer.write(from.address, 8, "utf8");
    answer.writeUInt16BE(from.port, 72);
    udp.send(answer, from.port, from.address);
  });
  server.listen(0, "127.0.0.1");
  udp.bind(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(udp, "listening")]);
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    udp.close();
    await new Promise(resolve => server.close(resolve));
  });

  const live = () => {
    const call = calls.filter(entry => entry.ws.readyState === entry.ws.OPEN && entry.client).at(-1);
    if (!call) throw new Error("No connected call");
    return call;
  };
  return {
    endpoint: `127.0.0.1:${(server.address() as { port: number }).port}`,
    identifies, resumes, calls,
    /** Tokens the server refuses (close 4004). */
    refuse: (token: string) => refused.add(token),
    /** Whether a call is connected (its client found its UDP address). */
    connected: () => calls.some(entry => entry.ws.readyState === entry.ws.OPEN && entry.client),
    /** The call's members, as Clients Connect tells a joining client; told to the live call at once. */
    members(userIds: string[]) {
      members = userIds;
      const call = calls.filter(entry => entry.ws.readyState === entry.ws.OPEN).at(-1);
      if (call) send(call.ws, 11, { user_ids: userIds });
    },
    leave(userId: string) {
      members = members.filter(id => id !== userId);
      send(live().ws, 13, { user_id: userId });
    },
    /**
     * `userId` speaks these Opus packets, from SSRC `ssrc`, one every `everyMs`. Speaking (op 5) tells which user an
     * SSRC is; Discord sends it once per SSRC and call, over the WebSocket, so it can trail the first packets on UDP:
     * `speakingAfter` sends it after that many (by default before any, the first time the SSRC speaks on this call).
     * `garbled` sends the packet at that index with a tag that does not authenticate (a packet that will not decrypt).
     */
    async speak(userId: string, ssrc: number, packets: Uint8Array[], everyMs = 2, options: { speakingAfter?: number; garbled?: number } = {}) {
      const call = live();
      const announce = !call.announced.has(ssrc);
      call.announced.add(ssrc);
      const speaking = () => send(call.ws, 5, { user_id: userId, ssrc, speaking: 1 });
      if (announce && !options.speakingAfter) {
        speaking();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      for (const [index, packet] of packets.entries()) {
        if (announce && options.speakingAfter && index === options.speakingAfter) {
          // Far enough behind the packets before it that they arrive first.
          await new Promise(resolve => setTimeout(resolve, 20));
          speaking();
        }
        const header = Buffer.alloc(12);
        header[0] = 0x80;
        header[1] = 0x78;
        header.writeUInt16BE(call.sequence++ & 0xffff, 2);
        header.writeUInt32BE((call.timestamp += 960) >>> 0, 4);
        header.writeUInt32BE(ssrc, 8);
        const nonce = Buffer.alloc(12);
        nonce.writeUInt32BE(call.nonce++, 0);
        const cipher = createCipheriv("aes-256-gcm", call.key, nonce);
        cipher.setAAD(header);
        const encrypted = Buffer.concat([cipher.update(packet), cipher.final()]);
        const tag = cipher.getAuthTag();
        if (index === options.garbled) tag[0] ^= 0xff;
        udp.send(Buffer.concat([header, encrypted, tag, nonce.subarray(0, 4)]), call.client!.port, call.client!.address);
        await new Promise(resolve => setTimeout(resolve, everyMs));
      }
    },
    /** Close the live call's voice gateway socket with a code, as Discord does. */
    close(code: number) { live().ws.close(code); },
  };
}
