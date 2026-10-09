import { createHash } from "node:crypto";
import { free, listen, runtime, type T } from "./runtime-server.ts";

// A runtime with image generation on a local stand-in for OpenAI's, for tests/image-generation*.test.ts.

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

/** A PNG's header (signature and IHDR) for an image of this size: all image-header.ts reads. */
export function png(width: number, height: number) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 6, 0, 0, 0], 16);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}
export const PHOTO = png(1024, 1024);

export type ImageCall = { key: string; path: string; fields: Record<string, string>; images: { name: string; type: string; bytes: number }[]; mask?: string };

/**
 * OpenAI's images endpoints (and an image at /photo.png, to fetch by URL), recording each request. Each image made is
 * a PNG of the size asked; usage is 10 text tokens and 1,000 image tokens per image given in, 1,000 tokens per image out.
 * A prompt with "forbidden" in it is refused by its safety system.
 */
async function fakeOpenAI(t: T) {
  const requests: ImageCall[] = [];
  const base = await listen(t, async (req, res) => {
    if (req.method === "GET" && req.url === "/photo.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(PHOTO);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const call: ImageCall = { key: String(req.headers.authorization), path: req.url!, fields: {}, images: [] };
    if (String(req.headers["content-type"]).startsWith("multipart/form-data")) {
      const form = await new Request("http://x", { method: "POST", headers: { "Content-Type": req.headers["content-type"]! }, body }).formData();
      for (const [name, value] of form) {
        if (typeof value === "string") call.fields[name] = value;
        else if (name === "mask") call.mask = value.type;
        else call.images.push({ name: value.name, type: value.type, bytes: value.size });
      }
    } else {
      for (const [name, value] of Object.entries(JSON.parse(body.toString()))) call.fields[name] = String(value);
    }
    requests.push(call);
    if (call.fields.prompt?.includes("forbidden")) {
      const error = { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked", moderation_details: { moderation_stage: "input", categories: ["violence"] } };
      return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
    }
    const [width, height] = (call.fields.size ?? "1024x1024").split("x").map(Number);
    const n = Number(call.fields.n ?? 1);
    const answer = {
      data: Array.from({ length: n }, () => ({ b64_json: png(width!, height!).toString("base64") })),
      usage: { input_tokens: 10 + 1000 * call.images.length, input_tokens_details: { text_tokens: 10, image_tokens: 1000 * call.images.length }, output_tokens: 1000 * n, output_tokens_details: { image_tokens: 1000 * n } },
    };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
  });
  return { base, requests };
}

/** The runtime, its model answering with `respond` (by default "ok"), and the fake OpenAI. */
export async function start(t: T, respond: (body: any, index: number) => object = () => ({ role: "assistant", content: "ok" })) {
  const openai = await fakeOpenAI(t);
  const r = await runtime(t, free(respond), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_IMAGES_URL: openai.base,
    AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0",
    // $100 per million image tokens out and $10 in, so an image (1,000 tokens) is $0.10 and an image given is $0.01.
    AGENT_PRICE_IMAGE_TEXT_INPUT_USD: "0", AGENT_PRICE_IMAGE_INPUT_USD: "10", AGENT_PRICE_IMAGE_OUTPUT_USD: "100",
  }, tenantsFile);
  return { r, openai };
}
