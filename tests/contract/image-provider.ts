import { createHash } from "node:crypto";
import { pngBytes as png } from "../file-fixtures.ts";
import { listen, type T } from "./http.ts";
export { png };
export const PHOTO = png(1024, 1024);
export type ImageCall = { key: string; apiKey?: string; path: string; fields: Record<string, string>; images: { name: string; type: string; bytes: number }[]; mask?: string };
export async function fakeOpenAI(t: T, azure = false) {
  const requests: ImageCall[] = [];
  const base = await listen(t, async (req, res) => {
    if (req.method === "GET" && req.url === "/photo.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(PHOTO);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const call: ImageCall = { key: String(req.headers.authorization), ...(req.headers["api-key"] ? { apiKey: String(req.headers["api-key"]) } : {}), path: req.url!, fields: {}, images: [] };
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
    if (azure && call.fields.prompt?.includes("busy")) return res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "30" }).end(JSON.stringify({ error: { code: "429", message: "Rate limit exceeded" } }));
    if (azure && call.fields.prompt?.includes("filtered")) {
      const error = { code: "contentFilter", message: "Your task failed as a result of our safety system.", inner_error: { code: "ResponsibleAIPolicyViolation", content_filter_results: { hate: { filtered: false, severity: "safe" }, violence: { filtered: true, severity: "medium" } } } };
      return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
    }
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

