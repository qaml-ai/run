import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { free, lastUser, listen, runtime, type T } from "./runtime-server.ts";

// A runtime with transcription on a local stand-in for OpenAI's, for tests/transcription-*.test.ts.

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const PAYG = "payg-operator-token-at-least-24-chars";
export const OWN = "own-operator-token-at-least-24-chars";
export const OPS = "ops-operator-token-at-least-24-chars";
export const CAPPED = "capped-operator-token-at-least-24-chars";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    // An operator's tenant that keeps to its own keys, and has no OpenAI key.
    own: { tokenSha256: sha(OWN), apiKeys: { openrouter: "fixture-model-key" }, platformKeys: false },
    ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } },
    capped: { tokenSha256: sha(CAPPED), apiKeys: { openrouter: "fixture-model-key" }, maxMonthlyCost: 0 },
  },
  platformKeys: { openrouter: "fixture-platform-model-key", openai: "platform-openai-key" },
};
export const HELLO = readFileSync(new URL("./fixtures/audio/hello.ogg", import.meta.url));

/** OpenAI's transcription endpoint (and the audio at /hello.ogg, to fetch by URL), recording each request's key and form. */
async function fakeOpenAI(t: T) {
  const requests: { key: string; model: string; language: string | null; name: string; bytes: number }[] = [];
  const base = await listen(t, async (req, res) => {
    if (req.method === "GET" && req.url === "/hello.ogg") return res.writeHead(200, { "Content-Type": "audio/ogg" }).end(HELLO);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Request("http://x", { method: "POST", headers: { "Content-Type": req.headers["content-type"]! }, body: Buffer.concat(chunks) }).formData();
    const file = form.get("file") as File;
    requests.push({ key: String(req.headers.authorization), model: String(form.get("model")), language: form.get("language") as string | null, name: file.name, bytes: file.size });
    const body = form.get("model") === "whisper-1"
      ? { language: "english", duration: 4.03, text: "Hello from camelRun.", segments: [{ start: 0, end: 4, text: "Hello from camelRun." }], usage: { type: "duration", seconds: 5 } }
      : { text: "Hello from camelRun.", languages: [{ code: "en" }], usage: { type: "duration", seconds: 5 } };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  return { base, requests };
}

/** A model that says what it heard: the last user message's text. */
const echo = free(body => ({ role: "assistant", content: `heard: ${lastUser(body)}` }));

export async function start(t: T) {
  const openai = await fakeOpenAI(t);
  const r = await runtime(t, echo, {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_TRANSCRIPTION_URL: openai.base,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0",
    // A cent a second, so charges are round.
    AGENT_PRICE_TRANSCRIPTION_GPT_TRANSCRIBE_USD: "0.6", AGENT_PRICE_TRANSCRIPTION_WHISPER_1_USD: "0.6",
  }, tenantsFile);
  return { r, openai };
}
