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
import { prepareSvg } from "./source.ts";
import { SVG_RENDER_LIMITS } from "./limits.ts";
import { escapeXml } from "./textbox.ts";

let initialization: Promise<void> | undefined;
const fontBuffers = [sans, bold, italic, boldItalic, serif, serifBold, serifItalic,
  mono, monoBold, math, symbols, symbols2, emoji].map(value => new Uint8Array(value));
const options = { font: {
  fontBuffers, loadSystemFonts: false, defaultFontFamily: "Noto Sans",
  sansSerifFamily: "Noto Sans", serifFamily: "Noto Serif", monospaceFamily: "Noto Sans Mono",
} };

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (Number(request.headers.get("content-length")) > SVG_RENDER_LIMITS.bodyBytes) {
      return Response.json({ error: "SVG request exceeds the byte budget" }, { status: 413 });
    }
    await (initialization ??= initWasm(wasm));
    let measurements = 0;
    let input;
    try {
      const { svg, files } = await request.json() as { svg?: unknown; files?: unknown };
      input = prepareSvg(svg, files, (text, font, fontSize = 100) => {
        if (++measurements > SVG_RENDER_LIMITS.textMeasurements) throw new Error("SVG textbox layout exceeds the measurement budget");
        const sample = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
          `<text${font} font-size="${fontSize}" xml:space="preserve">${escapeXml(text)}</text></svg>`, options);
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
      });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid SVG input" }, { status: 400 });
    }

    let renderer: InstanceType<typeof Resvg>;
    try {
      renderer = new Resvg(input.svg, options);
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
