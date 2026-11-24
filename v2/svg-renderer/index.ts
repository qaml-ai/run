import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import sans from "./fonts/NotoSans-Regular.ttf";
import bold from "./fonts/NotoSans-Bold.ttf";
import italic from "./fonts/NotoSans-Italic.ttf";
import boldItalic from "./fonts/NotoSans-BoldItalic.ttf";
import serif from "./fonts/NotoSerif-Regular.ttf";
import serifBold from "./fonts/NotoSerif-Bold.ttf";
import serifItalic from "./fonts/NotoSerif-Italic.ttf";
import mono from "./fonts/NotoSansMono-Regular.ttf";
import monoBold from "./fonts/NotoSansMono-Bold.ttf";
import math from "./fonts/NotoSansMath-Regular.ttf";
import symbols from "./fonts/NotoSansSymbols-Regular.ttf";
import symbols2 from "./fonts/NotoSansSymbols2-Regular.ttf";
import emoji from "./fonts/NotoEmoji.ttf";
import decorated from "./fonts/NotoDecorated-Subset.ttf";
import arabic from "./fonts/NotoSansArabic-Regular.ttf";
import devanagari from "./fonts/NotoSansDevanagari-Regular.ttf";
import hebrew from "./fonts/NotoSansHebrew-Regular.ttf";
import thai from "./fonts/NotoSansThai-Regular.ttf";
import {
  detectExtraScripts,
  type BundledExtraScriptId,
  type OnDemandScriptId,
} from "./fonts/coverage.ts";
import { prepareSvg } from "./source.ts";
import { SVG_RENDER_LIMITS } from "./limits.ts";
import { escapeXml } from "./textbox.ts";

interface RendererEnv {
  FONT_BUCKET?: R2Bucket;
}

const NOTO_CJK_COMMIT = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const ON_DEMAND_FONT_SPECS: Record<OnDemandScriptId, { r2Key: string; urls: readonly string[] }> = {
  "cjk-sc": {
    r2Key: "svg-fonts/NotoSansSC-Regular.otf",
    urls: [
      `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${NOTO_CJK_COMMIT}/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf`,
      `https://raw.githubusercontent.com/notofonts/noto-cjk/${NOTO_CJK_COMMIT}/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf`,
    ],
  },
  "cjk-kr": {
    r2Key: "svg-fonts/NotoSansKR-Regular.otf",
    urls: [
      `https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@${NOTO_CJK_COMMIT}/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf`,
      `https://raw.githubusercontent.com/notofonts/noto-cjk/${NOTO_CJK_COMMIT}/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf`,
    ],
  },
};

let initialization: Promise<void> | undefined;
const baseFontBuffers = [sans, bold, italic, boldItalic, serif, serifBold, serifItalic,
  mono, monoBold, math, symbols, symbols2, emoji].map(value => new Uint8Array(value));

const bundledExtraBuffers: Record<BundledExtraScriptId, Uint8Array<ArrayBuffer>> = {
  decorated: new Uint8Array(decorated),
  arabic: new Uint8Array(arabic),
  devanagari: new Uint8Array(devanagari),
  hebrew: new Uint8Array(hebrew),
  thai: new Uint8Array(thai),
};

const onDemandFontCache = new Map<OnDemandScriptId, Uint8Array<ArrayBuffer>>();
const onDemandInFlight = new Map<OnDemandScriptId, Promise<Uint8Array<ArrayBuffer> | undefined>>();

const baseFontConfig = {
  loadSystemFonts: false,
  defaultFontFamily: "Noto Sans",
  sansSerifFamily: "Noto Sans",
  serifFamily: "Noto Serif",
  monospaceFamily: "Noto Sans Mono",
} as const;

const baseOptions = {
  font: { ...baseFontConfig, fontBuffers: baseFontBuffers },
};

function buildResvgOptions(extraBuffers: Uint8Array<ArrayBuffer>[]) {
  if (extraBuffers.length === 0) return baseOptions;
  return {
    font: { ...baseFontConfig, fontBuffers: [...baseFontBuffers, ...extraBuffers] },
  };
}

async function fetchOnDemandFontBytes(
  id: OnDemandScriptId,
  env?: RendererEnv,
  ctx?: ExecutionContext,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const spec = ON_DEMAND_FONT_SPECS[id];

  // 1. Prefer intra-Cloudflare R2 bucket when bound and seeded.
  if (env?.FONT_BUCKET) {
    try {
      const obj = await env.FONT_BUCKET.get(spec.r2Key);
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        if (bytes.byteLength > 0) return bytes;
      }
    } catch {
      // Fall through to Cache API / CDN fallback.
    }
  }

  // 2. Check Cloudflare edge Cache API (caches.default) when available.
  const cacheKey = new Request(`https://svg-fonts.camelrun.internal/${spec.r2Key}`);
  let defaultCache: Cache | undefined;
  try {
    defaultCache = (caches as unknown as { default?: Cache }).default;
    if (defaultCache) {
      const cached = await defaultCache.match(cacheKey);
      if (cached && cached.ok) {
        const bytes = new Uint8Array(await cached.arrayBuffer());
        if (bytes.byteLength > 0) return bytes;
      }
    }
  } catch {
    defaultCache = undefined;
  }

  // 3. Fetch from pinned immutable CDN mirrors and populate edge cache.
  for (const url of spec.urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) continue;
      const bytes = new Uint8Array(buf);
      if (defaultCache) {
        const cacheResponse = new Response(bytes, {
          headers: {
            "content-type": "font/otf",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
        const putPromise = defaultCache.put(cacheKey, cacheResponse).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(putPromise);
        else await putPromise;
      }
      return bytes;
    } catch {
      // Try next mirror.
    }
  }

  return undefined;
}

async function loadOnDemandFont(
  id: OnDemandScriptId,
  env?: RendererEnv,
  ctx?: ExecutionContext,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const cached = onDemandFontCache.get(id);
  if (cached) return cached;

  const pending = onDemandInFlight.get(id);
  if (pending) return pending;

  const task = fetchOnDemandFontBytes(id, env, ctx).then(bytes => {
    if (bytes) onDemandFontCache.set(id, bytes);
    return bytes;
  }).finally(() => {
    onDemandInFlight.delete(id);
  });
  onDemandInFlight.set(id, task);
  return task;
}

export default {
  async fetch(request: Request, env?: RendererEnv, ctx?: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (Number(request.headers.get("content-length")) > SVG_RENDER_LIMITS.bodyBytes) {
      return Response.json({ error: "SVG request exceeds the byte budget" }, { status: 413 });
    }
    await (initialization ??= initWasm(wasm));

    let body: { svg?: unknown; files?: unknown };
    try {
      body = await request.json() as { svg?: unknown; files?: unknown };
    } catch {
      return Response.json({ error: "Invalid SVG input" }, { status: 400 });
    }

    const { svg, files } = body;
    const needed = typeof svg === "string" ? detectExtraScripts(svg) : { bundled: [], onDemand: [] };
    const loadedOnDemand = new Set<OnDemandScriptId>();
    const loadedOnDemandBuffers = new Map<OnDemandScriptId, Uint8Array<ArrayBuffer>>();

    if (needed.onDemand.length > 0) {
      const results = await Promise.all(
        needed.onDemand.map(async id => [id, await loadOnDemandFont(id, env, ctx)] as const),
      );
      for (const [id, bytes] of results) {
        if (bytes) {
          loadedOnDemand.add(id);
          loadedOnDemandBuffers.set(id, bytes);
        }
      }
    }

    const renderExtraBuffers: Uint8Array<ArrayBuffer>[] = [
      ...needed.bundled.map(id => bundledExtraBuffers[id]),
      ...loadedOnDemandBuffers.values(),
    ];
    const renderOptions = buildResvgOptions(renderExtraBuffers);
    const hasExtraFonts = renderExtraBuffers.length > 0;

    let measurements = 0;
    let input;
    try {
      input = prepareSvg(svg, files, (text, font, fontSize = 100) => {
        if (++measurements > SVG_RENDER_LIMITS.textMeasurements) throw new Error("SVG textbox layout exceeds the measurement budget");
        let measureOptions = baseOptions;
        if (hasExtraFonts) {
          const textNeeded = detectExtraScripts(text);
          if (textNeeded.bundled.length > 0 || textNeeded.onDemand.length > 0) {
            const textExtra: Uint8Array<ArrayBuffer>[] = textNeeded.bundled.map(id => bundledExtraBuffers[id]);
            for (const id of textNeeded.onDemand) {
              const buf = loadedOnDemandBuffers.get(id);
              if (buf) textExtra.push(buf);
            }
            measureOptions = buildResvgOptions(textExtra);
          }
        }
        const sample = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
          `<text${font} font-size="${fontSize}" xml:space="preserve">${escapeXml(text)}</text></svg>`, measureOptions);
        try {
          const box = sample.getBBox();
          if (!box) return;
          try {
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          } finally {
            box.free();
          }
        } finally {
          sample.free();
        }
      }, loadedOnDemand);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid SVG input" }, { status: 400 });
    }

    let renderer: InstanceType<typeof Resvg>;
    try {
      renderer = new Resvg(input.svg, renderOptions);
    } catch {
      return Response.json({ error: "The SVG could not be parsed by the renderer" }, { status: 400 });
    }

    try {
      const png = renderer.render();
      try {
        if (png.width !== input.width || png.height !== input.height) throw new Error("Unexpected SVG output dimensions");
        return new Response(new Uint8Array(png.asPng()), {
          headers: { "content-type": "image/png", "x-image-width": String(png.width), "x-image-height": String(png.height) },
        });
      } finally {
        png.free();
      }
    } finally {
      renderer.free();
    }
  },
};
