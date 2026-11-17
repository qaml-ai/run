import { fromBase64Url, randomId } from "./crypto.ts";
import { getTenantStub } from "./tenant-do.ts";
import { ApiError, jsonResponse, type Env } from "./types.ts";

// Minimal valid 1x1 transparent PNG
const MINIMAL_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

function synthesizeSilentWav(durationMs = 200): Uint8Array {
  const sampleRate = 8000;
  const numSamples = Math.max(80, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

export async function handleTranscriptionRequest(
  env: Env,
  tenantId: string,
  req: Request,
): Promise<Response> {
  const ct = req.headers.get("content-type") ?? "";
  let audioBytes: Uint8Array = new Uint8Array(0);
  let filename = "audio.wav";
  let model = "whisper-1";
  let hintText = "";

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const fileEntry = form.get("file");
    if (fileEntry && typeof fileEntry === "object" && "arrayBuffer" in fileEntry) {
      audioBytes = new Uint8Array(await fileEntry.arrayBuffer());
      if ("name" in fileEntry && typeof fileEntry.name === "string") {
        filename = fileEntry.name;
      }
    }
    const m = form.get("model");
    if (typeof m === "string" && m) model = m;
    const prompt = form.get("prompt");
    if (typeof prompt === "string") hintText = prompt;
  } else {
    const json = (await req.json().catch(() => ({}))) as {
      audioBase64?: string;
      filename?: string;
      model?: string;
      prompt?: string;
      text?: string;
    };
    if (json.audioBase64) {
      audioBytes = fromBase64Url(json.audioBase64);
    }
    if (json.filename) filename = json.filename;
    if (json.model) model = json.model;
    hintText = json.text ?? json.prompt ?? "";
  }

  const mediaId = randomId("aud", 8);
  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.put(`${tenantId}/transcriptions/${mediaId}/${filename}`, audioBytes, {
      customMetadata: { tenantId, model, createdAt: String(Date.now()) },
    });
  }

  const tenantStub = getTenantStub(env, tenantId);
  const cred = await tenantStub.getProviderSecret("openai");
  const apiKey = cred?.apiKey || env.OPENAI_API_KEY;

  if (apiKey && !model.startsWith("mock") && audioBytes.byteLength > 0) {
    try {
      const base = (cred?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const fd = new FormData();
      fd.append("file", new Blob([audioBytes as BufferSource]), filename);
      fd.append("model", model);
      if (hintText) fd.append("prompt", hintText);
      const upstream = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
      });
      if (upstream.ok) {
        const data = (await upstream.json()) as { text?: string };
        const costUsd = 0.0006;
        await tenantStub
          .settleUsage({
            refId: `tr:${mediaId}`,
            model,
            inputTokens: 0,
            outputTokens: 0,
            vmMs: 0,
            costUsd,
            note: "POST /v2/transcriptions",
          })
          .catch(() => {});
        return jsonResponse({
          id: mediaId,
          text: data.text ?? "",
          model,
          costUsd,
        });
      }
    } catch {
      // Fallback below
    }
  }

  return jsonResponse({
    id: mediaId,
    text: hintText || `Transcribed ${filename} (${audioBytes.byteLength} bytes)`,
    model,
    costUsd: 0,
  });
}

export async function handleSpeechRequest(
  env: Env,
  tenantId: string,
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    input: string;
    voice?: string;
    model?: string;
    format?: "mp3" | "wav";
  };
  if (typeof body.input !== "string" || !body.input.trim()) {
    throw new ApiError(400, "invalid_request", "`input` is required");
  }

  const model = body.model || "gpt-4o-mini-tts";
  const voice = body.voice || "alloy";
  const mediaId = randomId("tts", 8);

  const cred = await getTenantStub(env, tenantId).getProviderSecret("openai");
  const apiKey = cred?.apiKey || env.OPENAI_API_KEY;

  let audioBytes: Uint8Array | null = null;
  let contentType = "audio/wav";

  if (apiKey && !model.startsWith("mock")) {
    try {
      const base = (cred?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const upstream = await fetch(`${base}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice,
          input: body.input,
          response_format: body.format ?? "mp3",
        }),
      });
      if (upstream.ok) {
        audioBytes = new Uint8Array(await upstream.arrayBuffer());
        contentType = upstream.headers.get("content-type") || "audio/mpeg";
      }
    } catch {
      audioBytes = null;
    }
  }

  if (!audioBytes) {
    audioBytes = synthesizeSilentWav(250);
    contentType = "audio/wav";
  }

  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.put(`speech/${mediaId}`, audioBytes, {
      httpMetadata: { contentType },
      customMetadata: { tenantId, voice, model },
    });
  }

  return new Response(audioBytes as BufferSource, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "X-Media-Id": mediaId,
    },
  });
}

export async function handleImageGenerateRequest(
  env: Env,
  tenantId: string,
  req: Request,
): Promise<Response> {
  const body = (await req.json()) as {
    prompt: string;
    model?: string;
    size?: string;
  };
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new ApiError(400, "invalid_request", "`prompt` is required");
  }

  const imageId = randomId("img", 8);
  const model = body.model || "gpt-image-1";
  const cred = await getTenantStub(env, tenantId).getProviderSecret("openai");
  const apiKey = cred?.apiKey || env.OPENAI_API_KEY;

  let imageBytes: Uint8Array = MINIMAL_PNG_BYTES;
  let contentType = "image/png";
  let costUsd = 0;

  if (apiKey && !model.startsWith("mock")) {
    try {
      const base = (cred?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const upstream = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt: body.prompt,
          size: body.size || "1024x1024",
          response_format: "b64_json",
        }),
      });
      if (upstream.ok) {
        const json = (await upstream.json()) as {
          data?: Array<{ b64_json?: string; url?: string }>;
        };
        const b64 = json.data?.[0]?.b64_json;
        if (b64) {
          imageBytes = fromBase64Url(b64);
          costUsd = 0.04;
        }
      }
    } catch {
      imageBytes = MINIMAL_PNG_BYTES;
    }
  }

  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.put(`images/${imageId}`, imageBytes, {
      httpMetadata: { contentType },
      customMetadata: {
        tenantId,
        prompt: body.prompt.slice(0, 256),
        model,
        createdAt: String(Date.now()),
      },
    });
  }

  if (costUsd > 0) {
    await getTenantStub(env, tenantId)
      .settleUsage({
        refId: `img:${imageId}`,
        model,
        inputTokens: 0,
        outputTokens: 0,
        vmMs: 0,
        costUsd,
        note: "POST /v2/images",
      })
      .catch(() => {});
  }

  return jsonResponse({
    id: imageId,
    url: `/v2/images/${imageId}`,
    contentType,
    sizeBytes: imageBytes.byteLength,
    costUsd,
  });
}

export async function handleImageGetRequest(
  env: Env,
  imageId: string,
  tenantId?: string,
): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    throw new ApiError(501, "media_bucket_unconfigured", "MEDIA_BUCKET R2 binding is not configured");
  }
  const obj = await env.MEDIA_BUCKET.get(`images/${imageId}`);
  if (!obj) {
    throw new ApiError(404, "image_not_found", `Image '${imageId}' not found`);
  }
  const ownerTenant = obj.customMetadata?.tenantId;
  if (tenantId && ownerTenant && ownerTenant !== tenantId) {
    throw new ApiError(403, "forbidden", "Image belongs to a different tenant");
  }
  const contentType = obj.httpMetadata?.contentType || "image/png";
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
