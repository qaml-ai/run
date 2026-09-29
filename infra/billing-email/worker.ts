/** Cloudflare mail adapter. Only the runtime knows MAIL_SECRET; no account API key is deployed. */
export interface MailEnv {
  MAIL_SECRET: string;
  FROM: string;
  FEEDBACK_URL: string;
  EMAIL: { send(mail: { from: { email: string; name: string }; to: string; subject: string; html: string; text: string; headers: Record<string, string> }): Promise<{ messageId: string }> };
}
type QueueMessage = { body: any; ack(): void; retry(options: { delaySeconds: number }): void };

async function authorized(request: Request, secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret ?? "")) return false;
  const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(request.headers.get("authorization") ?? ""), hash(`Bearer ${secret}`)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128_000) throw new Error("Body too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request: Request, env: MailEnv): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/send") return new Response(null, { status: 404 });
    if (!await authorized(request, env.MAIL_SECRET)) return new Response(null, { status: 401 });
    let mail: any;
    try { mail = await readBody(request); } catch { return new Response(null, { status: 400 }); }
    if (!mail || mail.from !== env.FROM || typeof mail.to !== "string" || mail.to.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(mail.to) ||
      typeof mail.subject !== "string" || !mail.subject || mail.subject.length > 256 || /[\r\n]/.test(mail.subject) ||
      typeof mail.html !== "string" || typeof mail.text !== "string" || typeof mail.displayName !== "string" ||
      !mail.displayName.trim() || mail.displayName.length > 80 || /[\r\n]/.test(mail.displayName) ||
      !Array.isArray(mail.headers) || mail.headers.length > 2 || mail.headers.some((h: any) =>
        !h || !["List-Unsubscribe", "List-Unsubscribe-Post"].includes(h.Name) || typeof h.Value !== "string" || h.Value.length > 2048 || /[\r\n]/.test(h.Value))) {
      return new Response(null, { status: 400 });
    }
    try {
      const result = await env.EMAIL.send({ from: { email: env.FROM, name: mail.displayName }, to: mail.to,
        subject: mail.subject, html: mail.html, text: mail.text,
        headers: Object.fromEntries(mail.headers.map((h: { Name: string; Value: string }) => [h.Name, h.Value])),
      });
      if (!result.messageId) throw new Error("Missing message id");
      return Response.json({ messageId: result.messageId });
    } catch (error) {
      if ((error as { code?: string }).code === "E_RECIPIENT_SUPPRESSED") return Response.json({ suppressed: true });
      // Never log recipient addresses, mail content, confirmation URLs or provider errors.
      console.error(JSON.stringify({ type: "billing_mail_provider_failed" }));
      return new Response(null, { status: 502 });
    }
  },

  async queue(batch: { messages: QueueMessage[] }, env: MailEnv) {
    for (const message of batch.messages) {
      const event = message.body;
      const p = event?.payload;
      if (event?.source?.type !== "email.sending" || p?.sender !== env.FROM) { message.ack(); continue; }
      const kind = event.type === "cf.email.sending.message.complained" ? "complaint"
        : event.type === "cf.email.sending.message.bounced" && p.bounce?.type === "hard" ? "bounce"
        : event.type === "cf.email.sending.message.rejected" && p.rejection?.reason === "suppressed" && p.rejection?.party === "recipient" ? "suppressed" : undefined;
      if (!kind) { message.ack(); continue; }
      try {
        if (!/^[a-f0-9]{64}$/.test(env.MAIL_SECRET ?? "") || !env.FEEDBACK_URL.startsWith("https://")) throw new Error("Missing configuration");
        const response = await fetch(env.FEEDBACK_URL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.MAIL_SECRET}` },
          body: JSON.stringify({ sender: p.sender, recipient: p.recipient, messageId: p.messageId, kind }),
        });
        if (!response.ok) throw new Error("Feedback unavailable");
        message.ack();
      } catch {
        console.error(JSON.stringify({ type: "billing_mail_feedback_failed" }));
        message.retry({ delaySeconds: 300 });
      }
    }
  },
};
