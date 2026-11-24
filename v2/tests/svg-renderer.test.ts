import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { normalizeMissingGlyphs } from "../svg-renderer/fonts/coverage.ts";
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

test("normalizes font aliases in CSS (including font shorthand) and handles missing glyphs & ligatures safely", () => {
  const input = prepareSvg(
    '<svg width="20" height="10">' +
      '<style>.copy { font-family: "Serif", Sans, serif; } .sh { font: bold 24px Serif; } .sh2 { font: italic 16px/1.4 Mono, monospace; }</style>' +
      '<text style="font-family: Mono, monospace">𝑱𝒐𝒌𝒆𝒓 Ⓡⓘⓣⓐ Ｗｉｄｅ</text>' +
      '<text style="font: 700 18px/1.2 Serif">Hello</text>' +
    "</svg>",
    undefined,
  );
  assert.match(input.svg, /font-family: &quot;Noto Serif&quot;, Noto Sans, serif/);
  assert.match(input.svg, /font: bold 24px Noto Serif/);
  assert.match(input.svg, /font: italic 16px\/1\.4 Noto Sans Mono, monospace/);
  assert.match(input.svg, /font-family: Noto Sans Mono, monospace/);
  assert.match(input.svg, /font: 700 18px\/1\.2 Noto Serif/);
  assert.match(input.svg, /𝑱𝒐𝒌𝒆𝒓 Ⓡⓘⓣⓐ Wide/);

  // Ligature breaking for resvg 2.6.2 fallback bug + Symbols2 + uncovered CJK substitution.
  assert.equal(normalizeMissingGlyphs("Staff 🎉"), "Staf\u200cf 🎉");
  assert.equal(normalizeMissingGlyphs("Officer 𝑱𝒐𝒌𝒆𝒓 🎉"), "Of\u200cf\u200cicer 𝑱𝒐𝒌𝒆𝒓 🎉");
  assert.equal(normalizeMissingGlyphs("★ ☆ ♡ ♛ ✓ ✗ ✿ ❀"), "★ ☆ ♡ ♛ ✓ ✗ ✿ ❀");
  assert.equal(normalizeMissingGlyphs("東京 🎉"), "?? 🎉");

  // Flags, emoji ZWJ sequences, skin tones, keycaps, tag sequences, and decomposed combining accents.
  assert.equal(normalizeMissingGlyphs("Ana 🇧🇷"), "Ana 🇧\u200c🇷");
  assert.equal(normalizeMissingGlyphs("🇧🇷 Ana"), "🇧\u200c🇷 Ana");
  assert.equal(normalizeMissingGlyphs("Lucas 👍🏽"), "Lucas 👍");
  assert.equal(normalizeMissingGlyphs("Família 👨‍👩‍👧"), "Família 👨\u200c👩\u200c👧");
  assert.equal(normalizeMissingGlyphs("João ❤️‍🔥"), "João ❤️\u200c🔥");
  assert.equal(normalizeMissingGlyphs("Bia 🏳️‍🌈"), "Bia 🏳️\u200c🌈");
  assert.equal(normalizeMissingGlyphs("Jose\u0301"), "José");
  assert.equal(normalizeMissingGlyphs("1️⃣"), "1\uFE0F");
  assert.equal(normalizeMissingGlyphs("🏴󠁧󠁢󠁥󠁮󠁧󠁿"), "🏴");
});

test("textbox inherits styles, locks layout style, passes through visual attributes, centers consistently, and formats helpful errors", () => {
  const seenFonts: string[] = [];
  const mockMeasure = (text: string, font: string, fontSize = 100) => {
    seenFonts.push(`${font}@${fontSize}`);
    const scale = fontSize / 100;
    const isTall = /[Ágjpq|]/.test(text);
    return {
      x: 0,
      y: isTall ? -90 * scale : -55 * scale,
      width: Math.max(1, text.length * 50 * scale),
      height: (isTall ? 115 : 55) * scale,
    };
  };

  // Inherited styles from <g>, visual attributes pass-through, and locked style declarations.
  const prepared = prepareSvg(
    '<svg width="640" height="120">' +
      '<style>text { font-size: 40px; text-anchor: middle; } .accent { fill: #123456; }</style>' +
      '<g font-family="Serif" font-weight="bold" text-anchor="middle">' +
        '<textbox id="hdr" class="accent" x="20" y="20" width="400" height="52" font-size="24" ' +
          'stroke="#000" stroke-width="1" opacity="0.9" transform="rotate(0)" filter="url(#glow)" ' +
          'text-decoration="underline" paint-order="stroke" style="mix-blend-mode:multiply; font-size:99px">Hello</textbox>' +
      "</g>" +
    "</svg>",
    undefined,
    mockMeasure,
  );
  assert.ok(seenFonts.some(f => f.includes('font-family="Noto Serif"') && f.includes('font-weight="bold"')));
  assert.match(prepared.svg, /id="hdr"/);
  assert.match(prepared.svg, /class="accent"/);
  assert.match(prepared.svg, /stroke="#000"/);
  assert.match(prepared.svg, /stroke-width="1"/);
  assert.match(prepared.svg, /opacity="0\.9"/);
  assert.match(prepared.svg, /transform="rotate\(0\)"/);
  assert.match(prepared.svg, /filter="url\(#glow\)"/);
  assert.match(prepared.svg, /text-decoration="underline"/);
  assert.match(prepared.svg, /paint-order="stroke"/);
  assert.match(prepared.svg, /fill="#123456"/);
  assert.match(
    prepared.svg,
    /style="mix-blend-mode:multiply;font-size:24px;font-family:Noto Serif;font-weight:bold;font-style:normal;text-anchor:start;letter-spacing:normal;dominant-baseline:auto;alignment-baseline:auto;word-spacing:0;writing-mode:horizontal-tb;fill:#123456"/,
  );
  assert.match(
    prepared.svg,
    /<tspan x="[^"]+" y="[^"]+" style="font-size:24px;font-family:Noto Serif;font-weight:bold;font-style:normal;text-anchor:start;letter-spacing:normal;dominant-baseline:auto;alignment-baseline:auto;word-spacing:0;writing-mode:horizontal-tb">Hello<\/tspan>/,
  );

  // CSS/inherited font-size is used as starting size when <textbox> omits explicit font-size,
  // including when <style> appears after <textbox>.
  const cssSize = prepareSvg(
    '<svg width="400" height="160">' +
      '<textbox class="value" x="20" y="20" width="300" height="52">Hello</textbox>' +
      '<g font-size="26"><textbox x="20" y="90" width="300" height="52">Inherited</textbox></g>' +
      "<style>.value { font-size: 28px; font-weight: bold; }</style>" +
    "</svg>",
    undefined,
    mockMeasure,
  );
  assert.match(cssSize.svg, /font-size:28px;font-family:Noto Sans;font-weight:bold/);
  assert.match(cssSize.svg, /font-size:26px;font-family:Noto Sans;font-weight:normal/);

  // Explicit literal newlines inside <textbox> produce distinct lines.
  const multiline = prepareSvg(
    '<svg width="400" height="120"><textbox x="10" y="10" width="300" height="100" font-size="20">Line 1\nLine 2</textbox></svg>',
    undefined,
    mockMeasure,
  );
  const lineTexts = [...multiline.svg.matchAll(/<tspan [^>]+>([^<]+)<\/tspan>/g)].map(m => m[1]);
  assert.deepEqual(lineTexts, ["Line 1", "Line 2"]);

  // Measurement-budget error identifies the offending textbox by index, id, and coordinates.
  let calls = 0;
  assert.throws(
    () =>
      prepareSvg(
        '<svg width="400" height="160">' +
          '<textbox x="10" y="10" width="200" height="40" font-size="16">Ok</textbox>' +
          '<textbox id="dense-box" x="10" y="70" width="200" height="40" font-size="16">Trigger budget</textbox>' +
        "</svg>",
        undefined,
        (text, font, fontSize) => {
          if (++calls > 2) throw new Error("SVG textbox layout exceeds the measurement budget");
          return mockMeasure(text, font, fontSize);
        },
      ),
    /measurement budget at textbox \(#2, id="dense-box", x=10, y=70, 200x40\) for "Trigger budget"/,
  );

  // Consistent vertical centering: "ana" and "Ágata Jüngling" in identical boxes get the EXACT same baseline y.
  const row = prepareSvg(
    '<svg width="700" height="100">' +
      '<textbox x="10" y="20" width="300" height="52" font-size="24">ana</textbox>' +
      '<textbox x="350" y="20" width="300" height="52" font-size="24">Ágata Jüngling</textbox>' +
    "</svg>",
    undefined,
    mockMeasure,
  );
  const ys = [...row.svg.matchAll(/<tspan x="[^"]+" y="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ys.length, 2);
  assert.equal(ys[0], ys[1], `Expected identical baseline y for "ana" and "Ágata Jüngling", got ${ys[0]} vs ${ys[1]}`);

  // Informative error message with box coordinates, dimensions, and text preview.
  assert.throws(
    () => prepareSvg('<svg width="100" height="100"><textbox x="15" y="25" width="10" height="10" font-size="20">SuperLongOverflowingName</textbox></svg>', undefined, mockMeasure),
    /Textbox at \(x=15, y=25, 10x10\) for "SuperLongOverflowingName" is too small to fit its text/,
  );
});

test("the renderer Worker draws text, inherits styles, renders italic/symbols/emoji cleanly, and handles large paragraphs", async (t) => {
  const sharp = createRequire(new URL("../../package.json", import.meta.url))("sharp");
  const worker = await unstable_startWorker({
    config: fileURLToPath(new URL("../svg-renderer/wrangler.jsonc", import.meta.url)),
    dev: { logLevel: "none" },
  });
  t.after(() => worker.dispose());
  const url = await worker.url;

  const renderPng = async (svg: string, files?: Record<string, { data: string }>) => {
    const response = await worker.fetch(url, { method: "POST", body: JSON.stringify({ svg, files }) });
    if (!response.ok) assert.fail(`Render failed (${response.status}): ${await response.text()}`);
    return { response, buffer: Buffer.from(await response.arrayBuffer()) };
  };

  const assertAllInkInsideBoxes = async (pngBuf: Buffer, boxes: Array<[number, number, number, number]>) => {
    const { data, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ink = Array<number>(boxes.length).fill(0);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3] === 0) continue;
        const index = boxes.findIndex(([left, top, width, height]) => x >= left && x < left + width && y >= top && y < top + height);
        if (index < 0) assert.fail(`Text escaped its box at ${x},${y}`);
        ink[index]!++;
      }
    }
    assert.ok(ink.every(pixels => pixels > 25), `all boxes should contain visible text, ink=${JSON.stringify(ink)}`);
  };

  await t.test("draws text, embeds named raster inputs, and fits all spec textbox cases", async () => {
    const photo = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const { response, buffer: out } = await renderPng(
      '<svg width="200" height="100"><rect width="200" height="100" fill="white"/><image href="photo" x="2" y="2" width="12" height="12"/><text x="20" y="60" font-family="Sans" font-size="24">Camel AI</text></svg>',
      { photo: { data: photo.toString("base64") } },
    );
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-image-width"), "200");
    assert.equal(response.headers.get("x-image-height"), "100");
    const photoPixel = await sharp(out).extract({ left: 4, top: 4, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...photoPixel], [255, 0, 0]);
    const textPixels: Uint8Array = await sharp(out).extract({ left: 20, top: 30, width: 150, height: 35 }).removeAlpha().raw().toBuffer();
    assert.ok(textPixels.some(channel => channel < 60), "the bundled font should draw visible text");

    const { buffer: rich } = await renderPng(
      '<svg width="1200" height="410"><textbox x="30" y="25" width="1110" height="52" font-family="Sans" font-weight="bold" font-size="32">Maria da Conceição Gonçalves de Albuquerque e Silva Pereira Bragança</textbox><textbox x="30" y="90" width="420" height="44" font-family="Mono" font-size="32" align="end">VA-2026-000.000.142-RP / RG 98.765.432-1</textbox><textbox x="30" y="155" width="170" height="44" font-size="32" align="middle" valign="top">Não-binário</textbox><textbox x="30" y="215" width="340" height="44" font-size="32" valign="bottom">São José dos Campos do Rio Pardo de Minas, 20 de novembro de 2026</textbox><textbox x="30" y="275" width="120" height="52" font-size="32">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno</textbox><textbox x="30" y="340" width="340" height="44" font-family="Serif, serif" font-style="italic" font-size="32">𝑱𝒐𝒌𝒆𝒓 Ⓡⓘⓣⓐ 🙂</textbox><textbox width="5" height="5"/></svg>',
    );
    await assertAllInkInsideBoxes(rich, [
      [30, 25, 1110, 52],
      [30, 90, 420, 44],
      [30, 155, 170, 44],
      [30, 215, 340, 44],
      [30, 275, 120, 52],
      [30, 340, 340, 44],
    ]);
  });

  await t.test("inherited <g> font/weight/anchor/letter-spacing and <style> rules never let <textbox> overflow its box", async () => {
    const { buffer } = await renderPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="660" height="300">' +
        "<style>text { font-size: 40px; text-anchor: middle; }</style>" +
        '<g font-family="Serif" font-weight="bold">' +
          '<textbox x="20" y="20" width="600" height="52" font-size="32">Maria da Conceição Gonçalves de Albuquerque e Silva</textbox>' +
        "</g>" +
        '<g text-anchor="middle">' +
          '<textbox x="20" y="90" width="300" height="52" font-size="28">Centered Parent Anchor</textbox>' +
        "</g>" +
        '<g letter-spacing="4">' +
          '<textbox x="20" y="160" width="260" height="52" font-size="28">WIDE LETTER SPACING TEXT</textbox>' +
        "</g>" +
        '<textbox x="20" y="230" width="260" height="44" font-size="24">CSS text{font-size:40px} blocked</textbox>' +
      "</svg>",
    );
    await assertAllInkInsideBoxes(buffer, [
      [20, 20, 600, 52],
      [20, 90, 300, 52],
      [20, 160, 260, 52],
      [20, 230, 260, 44],
    ]);
  });

  await t.test("CSS targeting tspan/* and unlocked baseline/spacing/writing-mode properties cannot push <textbox> text out of box", async () => {
    // Repro 1: tspan{font-size:40px} and *{font-size:40px}
    const { buffer: tspanCss } = await renderPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="140">' +
        "<style>tspan { font-size: 40px; letter-spacing: 8px; } * { font-size: 40px; }</style>" +
        '<textbox x="20" y="20" width="260" height="44" font-size="24">CSS tspan{font-size:40px} blocked</textbox>' +
        '<textbox x="20" y="80" width="260" height="44">Inherited wildcard shrinks to fit</textbox>' +
      "</svg>",
    );
    await assertAllInkInsideBoxes(tspanCss, [
      [20, 20, 260, 44],
      [20, 80, 260, 44],
    ]);

    // Repro 2: .value with dominant-baseline:hanging, alignment-baseline:hanging, word-spacing, writing-mode
    const { buffer: baselineCss } = await renderPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="380" height="160">' +
        "<style>" +
          ".value { font-size: 28px; font-weight: bold; dominant-baseline: hanging; alignment-baseline: hanging; word-spacing: 24px; writing-mode: tb; }" +
          ".vert { writing-mode: vertical-rl; word-spacing: 30px; }" +
        "</style>" +
        '<textbox class="value" x="20" y="20" width="320" height="52">R$ 12.450,00</textbox>' +
        '<textbox class="vert" x="20" y="90" width="320" height="52" font-size="24">Two Words Stay Horizontal</textbox>' +
      "</svg>",
    );
    await assertAllInkInsideBoxes(baselineCss, [
      [20, 20, 320, 52],
      [20, 90, 320, 52],
    ]);

    // Verify .value actually rendered at 28px bold (substantially more ink than 16px normal)
    const { buffer: default16 } = await renderPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="380" height="80">' +
        '<textbox x="20" y="20" width="320" height="52">R$ 12.450,00</textbox>' +
      "</svg>",
    );
    const { buffer: css28 } = await renderPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="380" height="80">' +
        "<style>.value { font-size: 28px; font-weight: bold; }</style>" +
        '<textbox class="value" x="20" y="20" width="320" height="52">R$ 12.450,00</textbox>' +
      "</svg>",
    );
    const countInk = async (buf: Buffer) => {
      const { data } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let ink = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) ink++;
      return ink;
    };
    const ink16 = await countInk(default16);
    const ink28 = await countInk(css28);
    assert.ok(ink28 > ink16 * 1.8, `Expected CSS .value 28px bold (${ink28}px) to render much larger than 16px default (${ink16}px)`);
  });

  await t.test("flags, emoji sequences, skin tones, and decomposed accents render without tofu boxes", async () => {
    const renderLine = (text: string) =>
      renderPng(`<svg width="480" height="80"><text x="10" y="55" font-family="Sans" font-size="32">${text}</text></svg>`);

    // 1. Decomposed accent (e + U+0301) renders identically to NFC precomposed José
    const [decomposed, precomposed] = await Promise.all([renderLine("Jose\u0301"), renderLine("José")]);
    assert.equal(Buffer.compare(decomposed.buffer, precomposed.buffer), 0, "Decomposed Jose\\u0301 must match NFC José");

    // 2. Skin tone modifier renders identically to base emoji (no trailing tofu box)
    const [skinTone, baseEmoji] = await Promise.all([renderLine("Lucas 👍🏽"), renderLine("Lucas 👍")]);
    assert.equal(Buffer.compare(skinTone.buffer, baseEmoji.buffer), 0, "Skin-tone emoji must render cleanly without box");

    // 3. Flags & ZWJ emoji sequences render distinct component glyphs (not identical tofu boxes)
    const distinctPairs: Array<[string, string, string]> = [
      ["trailing flag BR vs US", "Ana 🇧🇷", "Ana 🇺🇸"],
      ["leading flag BR vs US", "🇧🇷 Ana", "🇺🇸 Ana"],
      ["ZWJ family vs fire", "Família 👨‍👩‍👧", "Família 🔥🔥🔥"],
      ["ZWJ heart-fire vs plain heart", "João ❤️‍🔥", "João ❤️"],
      ["ZWJ rainbow flag vs white flag", "Bia 🏳️‍🌈", "Bia 🏳️"],
    ];
    for (const [label, a, b] of distinctPairs) {
      const [imgA, imgB] = await Promise.all([renderLine(a), renderLine(b)]);
      assert.notEqual(
        Buffer.compare(imgA.buffer, imgB.buffer),
        0,
        `${label}: "${a}" and "${b}" rendered identically (likely tofu boxes)`,
      );
    }

    // 4. All repro strings inside <textbox> fit strictly inside their boxes (and multiline \n breaks cleanly)
    const { buffer: reproBoxes } = await renderPng(
      '<svg width="420" height="360">' +
        '<textbox x="20" y="10" width="380" height="40" font-size="24">Ana 🇧🇷</textbox>' +
        '<textbox x="20" y="60" width="380" height="40" font-size="24">🇧🇷 Ana</textbox>' +
        '<textbox x="20" y="110" width="380" height="40" font-size="24">Lucas 👍🏽 · Jose\u0301</textbox>' +
        '<textbox x="20" y="160" width="380" height="40" font-size="24">Família 👨‍👩‍👧</textbox>' +
        '<textbox x="20" y="210" width="380" height="40" font-size="24">João ❤️‍🔥 · Bia 🏳️‍🌈</textbox>' +
        '<textbox x="20" y="260" width="380" height="80" font-size="22">First Line\nSecond Line</textbox>' +
      "</svg>",
    );
    await assertAllInkInsideBoxes(reproBoxes, [
      [20, 10, 380, 40],
      [20, 60, 380, 40],
      [20, 110, 380, 40],
      [20, 160, 380, 40],
      [20, 210, 380, 40],
      [20, 260, 380, 80],
    ]);
  });

  await t.test("font fallback does not stall mid-line after ff/fi/fl ligatures, Symbols 2, or uncovered scripts", async () => {
    const pairs: Array<[string, string, string]> = [
      ["ff ligature + emoji", "Staff 🎉", "Staff 🌙"],
      ["ffi ligature + math + emoji", "Officer 𝑱𝒐𝒌𝒆𝒓 🎉", "Officer 𝑱𝒐𝒌𝒆𝒓 🌙"],
      ["Symbols 2 check + math", "✓ 𝑱𝒐𝒌𝒆𝒓", "✓ 𝑨𝑩𝑪𝑫𝑬"],
      ["Symbols 2 heart + emoji", "♡ Luna 🌙", "♡ Luna 🎉"],
      ["uncovered CJK + trailing emoji", "東京 🎉", "東京 🌙"],
      ["Symbols 2 distinct glyphs", "★ ☆ ♡ ♛ ✓ ✗ ✿ ❀", "❀ ✿ ✗ ✓ ♛ ♡ ☆ ★"],
    ];
    for (const [label, a, b] of pairs) {
      const renderLine = (text: string) => renderPng(
        `<svg width="400" height="70"><text x="10" y="50" font-family="Sans" font-size="32">${text}</text></svg>`,
      );
      const [imgA, imgB] = await Promise.all([renderLine(a), renderLine(b)]);
      assert.notEqual(
        Buffer.compare(imgA.buffer, imgB.buffer),
        0,
        `${label}: "${a}" and "${b}" rendered identically (likely fallback tofu boxes)`,
      );
    }
  });

  await t.test("NotoSerif-Italic renders visually distinct from NotoSerif-Regular", async () => {
    const [{ buffer: regular }, { buffer: italic }] = await Promise.all([
      renderPng('<svg width="240" height="80"><text x="10" y="55" font-family="Serif" font-style="normal" font-size="40">Hello</text></svg>'),
      renderPng('<svg width="240" height="80"><text x="10" y="55" font-family="Serif" font-style="italic" font-size="40">Hello</text></svg>'),
    ]);
    assert.notEqual(Buffer.compare(regular, italic), 0, "Serif italic must differ pixel-wise from Serif regular");
  });

  await t.test("measurement budget comfortably handles three 264-character paragraphs in one SVG", async () => {
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in repreh.";
    assert.equal(para.length, 264);
    const { buffer } = await renderPng(
      '<svg width="640" height="500">' +
        `<textbox x="20" y="20" width="600" height="140" font-size="18">${para}</textbox>` +
        `<textbox x="20" y="180" width="600" height="140" font-size="18">${para}</textbox>` +
        `<textbox x="20" y="340" width="600" height="140" font-size="18">${para}</textbox>` +
      "</svg>",
    );
    await assertAllInkInsideBoxes(buffer, [
      [20, 20, 600, 140],
      [20, 180, 600, 140],
      [20, 340, 600, 140],
    ]);
  });

  await t.test("too-small textbox returns 400 with position, dimensions, and text preview", async () => {
    const res = await worker.fetch(url, {
      method: "POST",
      body: JSON.stringify({
        svg: '<svg width="100" height="100"><textbox x="12" y="34" width="10" height="10" font-size="24">Overflowing Card Title</textbox></svg>',
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /x=12, y=34, 10x10/);
    assert.match(body.error, /Overflowing Card Title/);
  });
});
