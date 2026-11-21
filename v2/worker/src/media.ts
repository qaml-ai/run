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
    input?: string;
    text?: string;
    voice?: string;
    model?: string;
    format?: "mp3" | "wav" | "pcm";
  };
  const speechInput = typeof body.input === "string" ? body.input : typeof body.text === "string" ? body.text : "";
  if (!speechInput.trim()) {
    throw new ApiError(400, "invalid_request", "`input` or `text` is required");
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
          input: speechInput,
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const MAX_MODERATION_IMAGE_BYTES = 5 * 1024 * 1024;

export async function handleImageModerationRequest(
  env: Env,
  tenantId: string,
  req: Request,
): Promise<Response> {
  const rawCt = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (rawCt !== "image/jpeg" && rawCt !== "image/png") {
    throw new ApiError(400, "invalid_request", "Content-Type must be image/jpeg or image/png");
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new ApiError(400, "invalid_request", "Image body is empty");
  }
  if (buf.byteLength > MAX_MODERATION_IMAGE_BYTES) {
    throw new ApiError(413, "payload_too_large", "Image exceeds 5 MiB moderation limit");
  }

  const cred = await getTenantStub(env, tenantId).getProviderSecret("openai");
  const apiKey = cred?.apiKey || env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ApiError(503, "missing_provider_key", "OpenAI API key is not configured for image moderation");
  }

  const base = (cred?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const dataUrl = `data:${rawCt};base64,${bytesToBase64(new Uint8Array(buf))}`;
  const upstream = await fetch(`${base}/moderations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "omni-moderation-latest",
      input: [{ type: "image_url", image_url: { url: dataUrl } }],
    }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    throw new ApiError(
      upstream.status >= 500 ? 502 : upstream.status,
      "moderation_upstream_error",
      detail.slice(0, 300) || `Upstream moderation failed (${upstream.status})`,
    );
  }
  const data = (await upstream.json()) as {
    id?: string;
    model?: string;
    results?: Array<{
      flagged?: boolean;
      categories?: Record<string, boolean>;
      category_scores?: Record<string, number>;
      category_applied_input_types?: Record<string, string[]>;
    }>;
  };
  const first = data.results?.[0];
  if (!data.id || !data.model || !first || typeof first.flagged !== "boolean") {
    throw new ApiError(502, "moderation_upstream_error", "Malformed moderation response");
  }
  return jsonResponse({
    id: data.id,
    model: data.model,
    flagged: first.flagged,
    categories: first.categories ?? {},
    category_scores: first.category_scores ?? {},
    category_applied_input_types: first.category_applied_input_types ?? {},
  });
}

type VoiceProvider = "elevenlabs" | "grok" | "openai" | "gemini";

interface LibraryVoice {
  provider: VoiceProvider;
  id: string;
  name: string;
  description: string | null;
  labels: Record<string, string>;
  previewUrl: string | null;
  category: string | null;
  publicOwnerId: string | null;
}

const BUILTIN_VOICES: Record<Exclude<VoiceProvider, "elevenlabs">, Array<{ id: string; name: string; description: string; labels: Record<string, string> }>> = {
  openai: [
    { id: "alloy", name: "Alloy", description: "Neutral and balanced voice", labels: { gender: "neutral" } },
    { id: "ash", name: "Ash", description: "Clear and steady voice", labels: { gender: "male" } },
    { id: "ballad", name: "Ballad", description: "Warm and expressive voice", labels: { gender: "male" } },
    { id: "coral", name: "Coral", description: "Bright and friendly voice", labels: { gender: "female" } },
    { id: "echo", name: "Echo", description: "Resonant and calm voice", labels: { gender: "male" } },
    { id: "sage", name: "Sage", description: "Calm and measured voice", labels: { gender: "female" } },
    { id: "shimmer", name: "Shimmer", description: "Crisp and upbeat voice", labels: { gender: "female" } },
    { id: "verse", name: "Verse", description: "Dynamic and engaging voice", labels: { gender: "male" } },
    { id: "marin", name: "Marin", description: "Natural conversational voice", labels: { gender: "female" } },
    { id: "cedar", name: "Cedar", description: "Grounded conversational voice", labels: { gender: "male" } },
  ],
  grok: [
    { id: "ara", name: "Ara", description: "Warm conversational female voice", labels: { gender: "female" } },
    { id: "eve", name: "Eve", description: "Energetic female voice", labels: { gender: "female" } },
    { id: "leo", name: "Leo", description: "Authoritative male voice", labels: { gender: "male" } },
    { id: "rex", name: "Rex", description: "Confident male voice", labels: { gender: "male" } },
    { id: "sal", name: "Sal", description: "Smooth balanced voice", labels: { gender: "neutral" } },
  ],
  gemini: [
    { id: "Puck", name: "Puck", description: "Upbeat conversational voice", labels: {} },
    { id: "Charon", name: "Charon", description: "Informative deeper voice", labels: {} },
    { id: "Kore", name: "Kore", description: "Firm clear voice", labels: {} },
    { id: "Fenrir", name: "Fenrir", description: "Excitable expressive voice", labels: {} },
    { id: "Aoede", name: "Aoede", description: "Breezy conversational voice", labels: {} },
    { id: "Leda", name: "Leda", description: "Youthful bright voice", labels: {} },
    { id: "Orus", name: "Orus", description: "Firm steady voice", labels: {} },
    { id: "Zephyr", name: "Zephyr", description: "Bright smooth voice", labels: {} },
  ],
};

export async function handleVoiceSearchRequest(
  env: Env,
  tenantId: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  const rawProvider = (url.searchParams.get("provider") ?? "elevenlabs").trim().toLowerCase();
  if (rawProvider !== "elevenlabs" && rawProvider !== "openai" && rawProvider !== "grok" && rawProvider !== "gemini") {
    throw new ApiError(400, "invalid_request", "Unsupported voice provider");
  }
  const q = (url.searchParams.get("q") ?? "").trim();
  const category = (url.searchParams.get("category") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit") ?? 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 10;

  if (rawProvider !== "elevenlabs") {
    const qLower = q.toLowerCase();
    const voices: LibraryVoice[] = BUILTIN_VOICES[rawProvider]
      .filter((v) => !qLower || v.name.toLowerCase().includes(qLower) || v.id.toLowerCase().includes(qLower) || v.description.toLowerCase().includes(qLower))
      .slice(0, limit)
      .map((v) => ({
        provider: rawProvider,
        id: v.id,
        name: v.name,
        description: v.description,
        labels: v.labels,
        previewUrl: null,
        category: null,
        publicOwnerId: null,
      }));
    return jsonResponse({ voices });
  }

  const cred = await getTenantStub(env, tenantId).getProviderSecret("elevenlabs");
  const apiKey = cred?.apiKey || env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new ApiError(503, "missing_provider_key", "ElevenLabs API key is not configured for voice search");
  }
  const base = (cred?.baseUrl || env.VOICE_ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, "");
  const query = new URLSearchParams({ page_size: String(limit) });
  if (q) query.set("search", q);
  if (category) query.set("category", category);

  const upstream = await fetch(`${base}/v1/shared-voices?${query.toString()}`, {
    headers: { "xi-api-key": apiKey, Accept: "application/json" },
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    throw new ApiError(
      upstream.status >= 500 ? 502 : upstream.status,
      "voice_search_upstream_error",
      detail.slice(0, 300) || `ElevenLabs voice search failed (${upstream.status})`,
    );
  }
  const data = (await upstream.json()) as {
    voices?: Array<{
      voice_id?: string;
      name?: string;
      description?: string | null;
      preview_url?: string | null;
      category?: string | null;
      public_owner_id?: string | null;
      accent?: string;
      gender?: string;
      age?: string;
      descriptive?: string;
      use_case?: string;
      language?: string;
    }>;
  };
  const voices: LibraryVoice[] = (data.voices ?? [])
    .filter((v): v is typeof v & { voice_id: string; name: string } => typeof v.voice_id === "string" && typeof v.name === "string")
    .slice(0, limit)
    .map((v) => {
      const labels: Record<string, string> = {};
      for (const [k, val] of [
        ["accent", v.accent],
        ["gender", v.gender],
        ["age", v.age],
        ["descriptive", v.descriptive],
        ["use_case", v.use_case],
        ["language", v.language],
      ] as const) {
        if (typeof val === "string" && val.trim()) labels[k] = val.trim();
      }
      return {
        provider: "elevenlabs",
        id: v.voice_id,
        name: v.name,
        description: typeof v.description === "string" ? v.description : null,
        labels,
        previewUrl: typeof v.preview_url === "string" ? v.preview_url : null,
        category: typeof v.category === "string" ? v.category : null,
        publicOwnerId: typeof v.public_owner_id === "string" ? v.public_owner_id : null,
      };
    });
  return jsonResponse({ voices });
}
