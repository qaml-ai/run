import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import sans from "./fonts/NotoSans-Regular.ttf";
import bold from "./fonts/NotoSans-Bold.ttf";
import serif from "./fonts/NotoSerif-Regular.ttf";
import mono from "./fonts/NotoSansMono-Regular.ttf";
import { prepareSvg } from "./source.ts";
import { SVG_RENDER_LIMITS } from "./limits.ts";

let initialization: Promise<void> | undefined;
const fonts = [sans, bold, serif, mono].map(value => new Uint8Array(value));

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (Number(request.headers.get("content-length")) > SVG_RENDER_LIMITS.bodyBytes) {
      return Response.json({ error: "SVG request exceeds the byte budget" }, { status: 413 });
    }
    let input;
    try {
      const { svg, files } = await request.json() as { svg?: unknown; files?: unknown };
      input = prepareSvg(svg, files);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid SVG input" }, { status: 400 });
    }

    await (initialization ??= initWasm(wasm));
    let renderer: InstanceType<typeof Resvg>;
    try {
      renderer = new Resvg(input.svg, {
        font: {
          fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Noto Sans",
          sansSerifFamily: "Noto Sans", serifFamily: "Noto Serif", monospaceFamily: "Noto Sans Mono",
        },
      });
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
