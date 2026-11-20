import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { prepareSvg } from "../svg-renderer/source.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC";
test("bounds SVG dimensions and resolves only named raster inputs", () => {
  const input = prepareSvg('<svg viewBox="0 0 20 10"><image href="photo"/><text font-family="Sans">&lt;card&gt;</text></svg>', {
    photo: { data: png },
  });
  assert.equal(input.width, 20);
  assert.equal(input.height, 10);
  assert.match(input.svg, /data:image\/png;base64,/);
  assert.match(input.svg, /font-family="Noto Sans">&lt;card&gt;/);
  assert.throws(() => prepareSvg('<svg width="3000" height="2000"/>', undefined), /4 megapixels/);
  assert.throws(() => prepareSvg('<svg width="2" height="2"><image href="https://example.invalid/x.png"/></svg>', undefined), /name an image/);
  assert.throws(() => prepareSvg('<svg width="2" height="2"><image href="data:image/png;base64,abc"/></svg>', undefined), /name an image/);
  assert.throws(() => prepareSvg('<svg width="2" height="2"><use href="file:///tmp/fixture"/></svg>', undefined), /external resource/);
  assert.throws(() => prepareSvg('<!DOCTYPE svg><svg width="2" height="2"/>', undefined), /document declaration/);
});

test("normalizes font aliases in CSS and keeps styled Unicode glyphs when a font covers them", () => {
  const input = prepareSvg('<svg width="20" height="10"><style>.copy { font-family: "Serif", Sans, serif; }</style><text style="font-family: Mono, monospace">𝑱𝒐𝒌𝒆𝒓 Ⓡⓘⓣⓐ Ｗｉｄｅ</text></svg>', undefined);
  assert.match(input.svg, /font-family: &quot;Noto Serif&quot;, Noto Sans, serif/);
  assert.match(input.svg, /font-family: Noto Sans Mono, monospace/);
  assert.match(input.svg, /𝑱𝒐𝒌𝒆𝒓 Ⓡⓘⓣⓐ Wide/);
});

test("the renderer Worker draws text and embeds named raster inputs in the PNG", async () => {
  const sharp = createRequire(new URL("../../package.json", import.meta.url))("sharp");
  const worker = await unstable_startWorker({
    config: fileURLToPath(new URL("../svg-renderer/wrangler.jsonc", import.meta.url)),
    dev: { logLevel: "none" },
  });
  try {
    const photo = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const response = await worker.fetch(await worker.url, { method: "POST", body: JSON.stringify({
      svg: '<svg width="200" height="100"><rect width="200" height="100" fill="white"/><image href="photo" x="2" y="2" width="12" height="12"/><text x="20" y="60" font-family="Sans" font-size="24">Camel AI</text></svg>',
      files: { photo: { data: photo.toString("base64") } },
    }) });
    if (!response.ok) assert.fail(await response.text());
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-image-width"), "200");
    assert.equal(response.headers.get("x-image-height"), "100");
    const out = Buffer.from(await response.arrayBuffer());
    const photoPixel = await sharp(out).extract({ left: 4, top: 4, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...photoPixel], [255, 0, 0]);
    const textPixels: Uint8Array = await sharp(out).extract({ left: 20, top: 30, width: 150, height: 35 }).removeAlpha().raw().toBuffer();
    assert.ok(textPixels.some(channel => channel < 60), "the bundled font should draw visible text");

    const rich = await worker.fetch(await worker.url, { method: "POST", body: JSON.stringify({
      svg: '<svg width="1200" height="410"><textbox x="30" y="25" width="1110" height="52" font-family="Sans" font-weight="bold" font-size="32">Maria da Conceição Gonçalves de Albuquerque e Silva Pereira Bragança</textbox><textbox x="30" y="90" width="420" height="44" font-family="Mono" font-size="32" align="end">VA-2026-000.000.142-RP / RG 98.765.432-1</textbox><textbox x="30" y="155" width="170" height="44" font-size="32" align="middle" valign="top">Não-binário</textbox><textbox x="30" y="215" width="340" height="44" font-size="32" valign="bottom">São José dos Campos do Rio Pardo de Minas, 20 de novembro de 2026</textbox><textbox x="30" y="275" width="120" height="52" font-size="32">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno</textbox><textbox x="30" y="340" width="340" height="44" font-family="Serif, serif" font-style="italic" font-size="32">𝑱𝒐𝒌𝒆𝒓 Ⓡⓘⓣⓐ 🙂</textbox><textbox width="5" height="5"/></svg>',
    }) });
    if (!rich.ok) assert.fail(await rich.text());
    const { data, info } = await sharp(Buffer.from(await rich.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const boxes = [[30, 25, 1110, 52], [30, 90, 420, 44], [30, 155, 170, 44], [30, 215, 340, 44], [30, 275, 120, 52], [30, 340, 340, 44]];
    const ink = Array<number>(boxes.length).fill(0);
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] === 0) continue;
      const index = boxes.findIndex(([left, top, width, height]) => x >= left! && x < left! + width! && y >= top! && y < top! + height!);
      if (index < 0) assert.fail(`Text escaped its box at ${x},${y}`);
      ink[index]!++;
    }
    assert.ok(ink.every(pixels => pixels > 25), "all boxes should contain visible text");
  } finally {
    await worker.dispose();
  }
});
