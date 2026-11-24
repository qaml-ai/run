import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

// Binary payload whose standard base64 contains '+', '/', and '='
const BINARY_AUDIO_BYTES = new Uint8Array([0xfb, 0xff, 0xfe, 0xfd, 0x3e, 0x3f, 0x00, 0x01, 0x80, 0xff]);
const BINARY_AUDIO_STD_B64 = Buffer.from(BINARY_AUDIO_BYTES).toString("base64");
const BINARY_AUDIO_URL_B64 = BINARY_AUDIO_STD_B64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
assert.ok(BINARY_AUDIO_STD_B64.includes("+") && BINARY_AUDIO_STD_B64.includes("/") && BINARY_AUDIO_STD_B64.endsWith("="));

// Valid 1x1 PNG whose standard base64 contains '+', '/', and '='
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_1X1_BYTES = new Uint8Array(Buffer.from(PNG_1X1_B64, "base64"));

// Second distinct image payload whose standard base64 contains '+', '/', and '='
const GENERATED_IMAGE_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfb, 0xff, 0xfe, 0x3e, 0x3f, 0xab, 0xcd, 0xef, 0x12,
]);
const GENERATED_IMAGE_B64 = Buffer.from(GENERATED_IMAGE_BYTES).toString("base64");
assert.ok(GENERATED_IMAGE_B64.includes("+") && GENERATED_IMAGE_B64.includes("/") && GENERATED_IMAGE_B64.endsWith("="));

const EDITED_IMAGE_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x3e, 0x3f,
]);
const EDITED_IMAGE_B64 = Buffer.from(EDITED_IMAGE_BYTES).toString("base64");

interface CapturedFormFile {
  field: string;
  name: string;
  type: string;
  bytes: Uint8Array;
}

interface CapturedRequest {
  method: string;
  path: string;
  contentType: string;
  json?: Record<string, unknown>;
  formFields?: Record<string, string[]>;
  formFiles?: CapturedFormFile[];
}

test("POST /v2/transcriptions and POST /v2/images harden OpenAI media handling", async (t) => {
  const captured: CapturedRequest[] = [];
  let nextTranscriptionResponse:
    | { status: number; body: unknown }
    | undefined;
  let nextImageResponse:
    | { status: number; body: unknown }
    | undefined;

  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBuf = Buffer.concat(chunks);
    const path = req.url ?? "";
    const contentType = String(req.headers["content-type"] ?? "");

    if (path === "/generated-asset.png" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from(GENERATED_IMAGE_BYTES));
      return;
    }

    const entry: CapturedRequest = { method: req.method ?? "GET", path, contentType };
    if (contentType.includes("multipart/form-data")) {
      const formReq = new Request(`http://127.0.0.1${path}`, {
        method: req.method,
        headers: { "content-type": contentType },
        body: rawBuf,
      });
      const form = await formReq.formData();
      const formFields: Record<string, string[]> = {};
      const formFiles: CapturedFormFile[] = [];
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          (formFields[key] ??= []).push(value);
        } else {
          formFiles.push({
            field: key,
            name: value.name,
            type: value.type,
            bytes: new Uint8Array(await value.arrayBuffer()),
          });
        }
      }
      entry.formFields = formFields;
      entry.formFiles = formFiles;
    } else if (rawBuf.length > 0 && contentType.includes("application/json")) {
      entry.json = JSON.parse(rawBuf.toString("utf8")) as Record<string, unknown>;
    }
    captured.push(entry);

    if (path === "/v1/audio/transcriptions") {
      const planned = nextTranscriptionResponse ?? {
        status: 200,
        body: { text: "hello world", language: "english", duration: 30 },
      };
      nextTranscriptionResponse = undefined;
      res.writeHead(planned.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(planned.body));
      return;
    }

    if (path === "/v1/images/generations") {
      const planned = nextImageResponse ?? {
        status: 200,
        body: { data: [{ b64_json: GENERATED_IMAGE_B64 }] },
      };
      nextImageResponse = undefined;
      res.writeHead(planned.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(planned.body));
      return;
    }

    if (path === "/v1/images/edits") {
      const planned = nextImageResponse ?? {
        status: 200,
        body: { data: [{ b64_json: EDITED_IMAGE_B64 }] },
      };
      nextImageResponse = undefined;
      res.writeHead(planned.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(planned.body));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unhandled mock path: ${path}` } }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const port = (upstream.address() as { port: number }).port;
  const mockOrigin = `http://127.0.0.1:${port}`;
  const mockOpenAiBase = `${mockOrigin}/v1`;

  const dir = mkdtempSync(join(tmpdir(), "camelrun-media-test-"));
  const config = join(dir, "wrangler.json");
  const adminKey = "fixture-media-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "media-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: adminKey,
        VAULT_SECRET: "fixture-media-vault-secret-32b!!",
        CAMELFS_URL: "http://127.0.0.1:1",
      },
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "media-test-bucket" }],
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://media.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;

  // Tenant WITH OpenAI credentials pointing at mock server
  const withKey = await CamelRun.createTenant({
    baseUrl: origin,
    adminKey,
    name: "media-with-key",
    initialCreditsUsd: 10,
    fetch: fetcher,
  });
  const clientWithKey = new CamelRun({ baseUrl: origin, apiKey: withKey.apiKey, fetch: fetcher });
  await clientWithKey.providers.set("openai", { apiKey: "sk-test-openai", baseUrl: mockOpenAiBase });

  // Tenant WITHOUT OpenAI credentials (tests mock fallback)
  const noKey = await CamelRun.createTenant({
    baseUrl: origin,
    adminKey,
    name: "media-no-key",
    initialCreditsUsd: 10,
    fetch: fetcher,
  });

  await t.test("POST /v2/transcriptions decodes standard base64, requests verbose_json, computes Whisper cost, and returns language + durationSeconds", async () => {
    const start = captured.length;
    nextTranscriptionResponse = {
      status: 200,
      body: { text: "Roll for initiative", language: "en", duration: 30 },
    };
    const res = await worker.fetch(`${origin}/v2/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audioBase64: BINARY_AUDIO_STD_B64,
        contentType: "audio/webm",
        prompt: "role, roll",
        language: "en",
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const data = (await res.json()) as {
      id: string;
      text: string;
      language: string | null;
      durationSeconds: number;
      model: string;
      costUsd: number;
    };
    assert.ok(data.id.startsWith("aud_"));
    assert.equal(data.text, "Roll for initiative");
    assert.equal(data.language, "en");
    assert.equal(data.durationSeconds, 30);
    assert.equal(data.model, "whisper-1");
    assert.equal(data.costUsd, 0.003);

    assert.equal(captured.length, start + 1);
    const req = captured[start]!;
    assert.equal(req.path, "/v1/audio/transcriptions");
    assert.deepEqual(req.formFields?.model, ["whisper-1"]);
    assert.deepEqual(req.formFields?.response_format, ["verbose_json"]);
    assert.deepEqual(req.formFields?.prompt, ["role, roll"]);
    assert.deepEqual(req.formFields?.language, ["en"]);
    assert.equal(req.formFiles?.length, 1);
    assert.equal(req.formFiles![0]!.field, "file");
    assert.equal(req.formFiles![0]!.name, "audio.webm");
    assert.equal(req.formFiles![0]!.type, "audio/webm");
    assert.deepEqual(req.formFiles![0]!.bytes, BINARY_AUDIO_BYTES);
  });

  await t.test("POST /v2/transcriptions decodes base64url and handles short/missing duration costs", async () => {
    const start = captured.length;
    nextTranscriptionResponse = {
      status: 200,
      body: { text: "short clip", duration: 0.2 },
    };
    const res1 = await worker.fetch(`${origin}/v2/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audioBase64: BINARY_AUDIO_URL_B64,
        filename: "clip.ogg",
        language: "fr",
      }),
    });
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as { language: string | null; durationSeconds: number; costUsd: number };
    assert.equal(body1.language, "fr");
    assert.equal(body1.durationSeconds, 0.2);
    assert.equal(body1.costUsd, 0.0001);
    assert.deepEqual(captured[start]!.formFiles![0]!.bytes, BINARY_AUDIO_BYTES);
    assert.equal(captured[start]!.formFiles![0]!.name, "clip.ogg");
    assert.equal(captured[start]!.formFiles![0]!.type, "audio/ogg");

    // Fallback cost 0.0006 when upstream omits duration
    nextTranscriptionResponse = {
      status: 200,
      body: { text: "no duration" },
    };
    const res2 = await worker.fetch(`${origin}/v2/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audioBase64: BINARY_AUDIO_STD_B64 }),
    });
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as { language: string | null; durationSeconds: number; costUsd: number };
    assert.equal(body2.language, null);
    assert.equal(body2.durationSeconds, 0);
    assert.equal(body2.costUsd, 0.0006);
  });

  await t.test("POST /v2/transcriptions supports multipart/form-data with file, model, prompt, language", async () => {
    const start = captured.length;
    nextTranscriptionResponse = {
      status: 200,
      body: { text: "multipart speech", language: "spanish", duration: 12 },
    };
    const form = new FormData();
    form.append("file", new File([BINARY_AUDIO_BYTES], "voice.mp3", { type: "audio/mpeg" }));
    form.append("model", "whisper-1");
    form.append("prompt", "hola");
    form.append("language", "es");
    const serializedForm = new Response(form);
    const multipartBody = await serializedForm.arrayBuffer();
    const multipartContentType = serializedForm.headers.get("content-type")!;

    const res = await worker.fetch(`${origin}/v2/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": multipartContentType,
      },
      body: multipartBody,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const data = (await res.json()) as { text: string; language: string | null; durationSeconds: number; costUsd: number };
    assert.equal(data.text, "multipart speech");
    assert.equal(data.language, "spanish");
    assert.equal(data.durationSeconds, 12);
    assert.ok(Math.abs(data.costUsd - 0.0012) < 1e-9);

    const req = captured[start]!;
    assert.equal(req.path, "/v1/audio/transcriptions");
    assert.deepEqual(req.formFields?.response_format, ["verbose_json"]);
    assert.deepEqual(req.formFields?.prompt, ["hola"]);
    assert.deepEqual(req.formFields?.language, ["es"]);
    assert.equal(req.formFiles![0]!.name, "voice.mp3");
    assert.equal(req.formFiles![0]!.type, "audio/mpeg");
    assert.deepEqual(req.formFiles![0]!.bytes, BINARY_AUDIO_BYTES);
  });

  await t.test("POST /v2/transcriptions propagates upstream non-2xx errors instead of returning fake text", async () => {
    nextTranscriptionResponse = {
      status: 429,
      body: { error: { message: "Rate limit exceeded on Whisper" } },
    };
    const res = await worker.fetch(`${origin}/v2/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audioBase64: BINARY_AUDIO_STD_B64 }),
    });
    assert.equal(res.status, 429);
    const err = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(err.error.code, "transcription_failed");
    assert.match(err.error.message, /Rate limit exceeded on Whisper/);
  });

  await t.test("POST /v2/transcriptions keeps mock fallback for mock* models and unconfigured keys", async () => {
    const before = captured.length;
    const mockModelRes = await worker.fetch(`${origin}/v2/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audioBase64: BINARY_AUDIO_STD_B64,
        model: "mock-whisper",
        language: "en",
      }),
    });
    assert.equal(mockModelRes.status, 200);
    const mockModelBody = (await mockModelRes.json()) as { text: string; language: string | null; durationSeconds: number; costUsd: number };
    assert.match(mockModelBody.text, /Transcribed audio\.wav \(10 bytes\)/);
    assert.equal(mockModelBody.language, "en");
    assert.equal(mockModelBody.durationSeconds, 0);
    assert.equal(mockModelBody.costUsd, 0);

    const noKeyRes = await worker.fetch(`${origin}/v2/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${noKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audioBase64: BINARY_AUDIO_STD_B64, prompt: "hint text" }),
    });
    assert.equal(noKeyRes.status, 200);
    const noKeyBody = (await noKeyRes.json()) as { text: string; costUsd: number };
    assert.equal(noKeyBody.text, "hint text");
    assert.equal(noKeyBody.costUsd, 0);
    assert.equal(captured.length, before, "mock fallbacks must not call upstream");
  });

  await t.test("POST /v2/images omits response_format for gpt-image-1, includes it for dall-e-3, and decodes standard base64 cleanly", async () => {
    const start = captured.length;
    const res = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "a camel at sunrise",
        model: "gpt-image-1",
        size: "1024x1024",
        quality: "medium",
        background: "transparent",
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const data = (await res.json()) as {
      id: string;
      url: string;
      contentType: string;
      sizeBytes: number;
      costUsd: number;
    };
    assert.ok(data.id.startsWith("img_"));
    assert.equal(data.url, `/v2/images/${data.id}`);
    assert.equal(data.contentType, "image/png");
    assert.equal(data.sizeBytes, GENERATED_IMAGE_BYTES.byteLength);
    assert.equal(data.costUsd, 0.04);

    // Verify exact decoded bytes stored in R2 (generated images remain public & immutable)
    const getRes = await worker.fetch(`${origin}/v2/images/${data.id}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(new Uint8Array(await getRes.arrayBuffer()), GENERATED_IMAGE_BYTES);

    const gptReq = captured[start]!;
    assert.equal(gptReq.path, "/v1/images/generations");
    assert.equal(gptReq.json?.model, "gpt-image-1");
    assert.equal(gptReq.json?.quality, "medium");
    assert.equal(gptReq.json?.background, "transparent");
    assert.equal("response_format" in (gptReq.json ?? {}), false, "gpt-image-* must omit response_format");

    // dall-e-3 includes response_format: "b64_json"
    const dalleRes = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "a camel in watercolor", model: "dall-e-3" }),
    });
    assert.equal(dalleRes.status, 200);
    const dalleReq = captured[start + 1]!;
    assert.equal(dalleReq.path, "/v1/images/generations");
    assert.equal(dalleReq.json?.response_format, "b64_json");

    // URL fallback when upstream returns { data: [{ url }] }
    nextImageResponse = {
      status: 200,
      body: { data: [{ url: `${mockOrigin}/generated-asset.png` }] },
    };
    const urlRes = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "downloaded from url" }),
    });
    assert.equal(urlRes.status, 200);
    const urlData = (await urlRes.json()) as { id: string; sizeBytes: number };
    assert.equal(urlData.sizeBytes, GENERATED_IMAGE_BYTES.byteLength);
    const fetchedImg = await worker.fetch(`${origin}/v2/images/${urlData.id}`, {
      headers: { authorization: `Bearer ${withKey.apiKey}` },
    });
    assert.deepEqual(new Uint8Array(await fetchedImg.arrayBuffer()), GENERATED_IMAGE_BYTES);
  });

  await t.test("POST /v2/images supports image editing via /images/edits FormData (1 and multiple images)", async () => {
    const start = captured.length;

    // Single reference image -> field name `image`
    const singleRes = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "add sunglasses",
        model: "gpt-image-1",
        size: "1024x1024",
        quality: "high",
        background: "opaque",
        images: [{ data: PNG_1X1_B64, mediaType: "image/png" }],
      }),
    });
    assert.equal(singleRes.status, 200, await singleRes.clone().text());
    const singleData = (await singleRes.json()) as { id: string; sizeBytes: number; costUsd: number };
    assert.equal(singleData.sizeBytes, EDITED_IMAGE_BYTES.byteLength);
    assert.equal(singleData.costUsd, 0.04);

    const singleReq = captured[start]!;
    assert.equal(singleReq.path, "/v1/images/edits");
    assert.deepEqual(singleReq.formFields?.model, ["gpt-image-1"]);
    assert.deepEqual(singleReq.formFields?.prompt, ["add sunglasses"]);
    assert.deepEqual(singleReq.formFields?.size, ["1024x1024"]);
    assert.deepEqual(singleReq.formFields?.quality, ["high"]);
    assert.deepEqual(singleReq.formFields?.background, ["opaque"]);
    assert.equal(singleReq.formFields?.response_format, undefined);
    assert.equal(singleReq.formFiles?.length, 1);
    assert.equal(singleReq.formFiles![0]!.field, "image");
    assert.equal(singleReq.formFiles![0]!.type, "image/png");
    assert.deepEqual(singleReq.formFiles![0]!.bytes, PNG_1X1_BYTES);

    // Multiple reference images -> field name `image[]`
    const multiRes = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "blend both scenes",
        images: [
          { data: PNG_1X1_B64, mediaType: "image/png" },
          { data: GENERATED_IMAGE_B64, mediaType: "image/webp" },
        ],
      }),
    });
    assert.equal(multiRes.status, 200, await multiRes.clone().text());
    const multiReq = captured[start + 1]!;
    assert.equal(multiReq.path, "/v1/images/edits");
    assert.equal(multiReq.formFiles?.length, 2);
    assert.equal(multiReq.formFiles![0]!.field, "image[]");
    assert.equal(multiReq.formFiles![1]!.field, "image[]");
    assert.equal(multiReq.formFiles![1]!.type, "image/webp");
    assert.deepEqual(multiReq.formFiles![0]!.bytes, PNG_1X1_BYTES);
    assert.deepEqual(multiReq.formFiles![1]!.bytes, GENERATED_IMAGE_BYTES);
  });

  await t.test("POST /v2/images validates reference images and propagates upstream errors", async () => {
    const before = captured.length;
    const tooMany = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "too many refs",
        images: Array.from({ length: 5 }, () => ({ data: PNG_1X1_B64 })),
      }),
    });
    assert.equal(tooMany.status, 400);

    const badMediaType = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: "bad media type",
        images: [{ data: PNG_1X1_B64, mediaType: "application/pdf" }],
      }),
    });
    assert.equal(badMediaType.status, 400);
    assert.equal(captured.length, before, "validation failures must not call upstream");

    nextImageResponse = {
      status: 400,
      body: { error: { message: "Your request was rejected by the safety system." } },
    };
    const errRes = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "rejected prompt" }),
    });
    assert.equal(errRes.status, 400);
    const errBody = (await errRes.json()) as { error: { code: string; message: string } };
    assert.equal(errBody.error.code, "image_generation_failed");
    assert.match(errBody.error.message, /rejected by the safety system/);
  });

  await t.test("POST /v2/images keeps MINIMAL_PNG_BYTES mock fallback for mock* models and unconfigured keys", async () => {
    const before = captured.length;
    const mockModelRes = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "mock image", model: "mock-image" }),
    });
    assert.equal(mockModelRes.status, 200);
    const mockData = (await mockModelRes.json()) as { id: string; sizeBytes: number; costUsd: number };
    assert.equal(mockData.sizeBytes, 67);
    assert.equal(mockData.costUsd, 0);

    const noKeyRes = await worker.fetch(`${origin}/v2/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${noKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "no key fallback" }),
    });
    assert.equal(noKeyRes.status, 200);
    const noKeyData = (await noKeyRes.json()) as { id: string; sizeBytes: number; costUsd: number };
    assert.equal(noKeyData.sizeBytes, 67);
    assert.equal(noKeyData.costUsd, 0);
    assert.equal(captured.length, before, "mock fallbacks must not call upstream");
  });

  await t.test("POST /v2/media and DELETE /v2/media/:id upload once, enforce tenant isolation, and delete cleanly", async () => {
    // 1. Raw image/png upload
    const rawRes = await worker.fetch(`${origin}/v2/media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "image/png",
      },
      body: PNG_1X1_BYTES,
    });
    assert.equal(rawRes.status, 200, await rawRes.clone().text());
    const rawMedia = (await rawRes.json()) as {
      id: string;
      url: string;
      expiresAt: string;
      contentType: string;
      width: number;
      height: number;
      sizeBytes: number;
    };
    assert.match(rawMedia.id, /^img_/);
    const signedUrl = new URL(rawMedia.url, origin);
    assert.equal(signedUrl.pathname, `/v2/images/${rawMedia.id}`);
    assert.match(signedUrl.searchParams.get("exp") ?? "", /^\d+$/);
    assert.match(signedUrl.searchParams.get("sig") ?? "", /^[0-9a-f]{64}$/);
    assert.ok(Date.parse(rawMedia.expiresAt) > Date.now());
    assert.equal(rawMedia.contentType, "image/png");
    assert.equal(rawMedia.width, 1);
    assert.equal(rawMedia.height, 1);
    assert.equal(rawMedia.sizeBytes, PNG_1X1_BYTES.byteLength);

    // Unauthenticated GET without signed params returns 401
    const unauthImg = await worker.fetch(`${origin}/v2/images/${rawMedia.id}`);
    assert.equal(unauthImg.status, 401);
    const unauthMedia = await worker.fetch(`${origin}/v2/media/${rawMedia.id}`);
    assert.equal(unauthMedia.status, 401);

    // Tampered or expired signed URL returns 401
    const tamperedSig = await worker.fetch(`${origin}/v2/images/${rawMedia.id}?exp=${signedUrl.searchParams.get("exp")}&sig=${"0".repeat(64)}`);
    assert.equal(tamperedSig.status, 401);
    const expiredSig = await worker.fetch(`${origin}/v2/images/${rawMedia.id}?exp=1&sig=${signedUrl.searchParams.get("sig")}`);
    assert.equal(expiredSig.status, 401);

    // Unauthenticated GET with returned short-lived signed URL succeeds with private Cache-Control
    const signedFetch = await worker.fetch(`${origin}${rawMedia.url}`);
    assert.equal(signedFetch.status, 200);
    assert.match(signedFetch.headers.get("cache-control") ?? "", /^private, max-age=\d+$/);
    assert.equal(signedFetch.headers.get("vary"), "Authorization");
    assert.deepEqual(new Uint8Array(await signedFetch.arrayBuffer()), PNG_1X1_BYTES);

    // Authenticated owner GET on bare /v2/images/:id and /v2/media/:id succeeds with private Cache-Control
    const fetched = await worker.fetch(`${origin}/v2/images/${rawMedia.id}`, {
      headers: { authorization: `Bearer ${withKey.apiKey}` },
    });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("cache-control"), "private, max-age=3600");
    assert.equal(fetched.headers.get("vary"), "Authorization");
    assert.deepEqual(new Uint8Array(await fetched.arrayBuffer()), PNG_1X1_BYTES);

    const fetchedMediaRoute = await worker.fetch(`${origin}/v2/media/${rawMedia.id}`, {
      headers: { authorization: `Bearer ${withKey.apiKey}` },
    });
    assert.equal(fetchedMediaRoute.status, 200);
    assert.deepEqual(new Uint8Array(await fetchedMediaRoute.arrayBuffer()), PNG_1X1_BYTES);

    // Cross-tenant authenticated GET returns 404 media_not_found (even with signed URL params)
    const crossGet = await worker.fetch(`${origin}/v2/images/${rawMedia.id}`, {
      headers: { authorization: `Bearer ${noKey.apiKey}` },
    });
    assert.equal(crossGet.status, 404);
    assert.equal(((await crossGet.json()) as { error: { code: string } }).error.code, "media_not_found");

    const crossGetSigned = await worker.fetch(`${origin}${rawMedia.url}`, {
      headers: { authorization: `Bearer ${noKey.apiKey}` },
    });
    assert.equal(crossGetSigned.status, 404);

    // 2. JSON base64 upload
    const jsonRes = await worker.fetch(`${origin}/v2/media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${withKey.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ data: PNG_1X1_B64, contentType: "image/png" }),
    });
    assert.equal(jsonRes.status, 200, await jsonRes.clone().text());
    const jsonMedia = (await jsonRes.json()) as { id: string; width: number; height: number };
    assert.match(jsonMedia.id, /^img_/);
    assert.equal(jsonMedia.width, 1);
    assert.equal(jsonMedia.height, 1);

    // 3. Invalid content-type / corrupted bytes rejected with 400
    const badCt = await worker.fetch(`${origin}/v2/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${withKey.apiKey}`, "content-type": "text/plain" },
      body: "not an image",
    });
    assert.equal(badCt.status, 400);

    const badImg = await worker.fetch(`${origin}/v2/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${withKey.apiKey}`, "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    assert.equal(badImg.status, 400);

    // 4. Cross-tenant DELETE returns 404 media_not_found
    const crossDel = await worker.fetch(`${origin}/v2/media/${rawMedia.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${noKey.apiKey}` },
    });
    assert.equal(crossDel.status, 404);
    const crossBody = (await crossDel.json()) as { error: { code: string } };
    assert.equal(crossBody.error.code, "media_not_found");

    // 5. Owner DELETE succeeds and removes object from R2
    const delRes = await worker.fetch(`${origin}/v2/media/${rawMedia.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${withKey.apiKey}` },
    });
    assert.equal(delRes.status, 200, await delRes.clone().text());
    assert.deepEqual(await delRes.json(), { ok: true, id: rawMedia.id, deleted: true });

    const delAgain = await worker.fetch(`${origin}/v2/media/${rawMedia.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${withKey.apiKey}` },
    });
    assert.equal(delAgain.status, 404);

    const getAfterDel = await worker.fetch(`${origin}${rawMedia.url}`, {
      headers: { authorization: `Bearer ${withKey.apiKey}` },
    });
    assert.equal(getAfterDel.status, 404);
  });
});
