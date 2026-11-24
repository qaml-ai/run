export type Box = { x: number; y: number; width: number; height: number };
export type MeasureText = (text: string, font: string, fontSize?: number) => Box | undefined;
export interface InheritedStyle {
  "font-family"?: string;
  "font-weight"?: string;
  "font-style"?: string;
  "font-size"?: string;
  "letter-spacing"?: string;
  fill?: string;
}

const referenceSize = 100;
const margin = 0.98;
const metricSample = "Ágjpq|";

const PASS_THROUGH_VISUAL_ATTRS = [
  "id",
  "class",
  "stroke",
  "stroke-width",
  "stroke-linejoin",
  "stroke-linecap",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "filter",
  "text-decoration",
  "paint-order",
  "clip-path",
  "mask",
  "visibility",
] as const;

const LOCKED_STYLE_PROPS = new Set([
  "font",
  "font-family",
  "font-weight",
  "font-style",
  "font-size",
  "line-height",
  "text-anchor",
  "letter-spacing",
  "dominant-baseline",
  "alignment-baseline",
  "word-spacing",
  "writing-mode",
  "fill",
]);

export const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function cleanPreview(text: string): string {
  const normalized = text.replaceAll("\u200c", "").replace(/\s+/g, " ").trim();
  return normalized.length > 32 ? `${normalized.slice(0, 32)}…` : normalized;
}

export function extractFontShorthand(value: string): Partial<InheritedStyle> & { "font-size"?: string } {
  const result: Partial<InheritedStyle> & { "font-size"?: string } = {};
  const cleaned = value.replace(/\s*!important\s*$/i, "").trim();
  const sizeMatch = cleaned.match(
    /(?:^|\s)((?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|ex|ch|vw|vh|vmin|vmax|%|cm|mm|in|pc)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*(?:normal|(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|%|cm|mm|in|pc)?))?\s+(.+)$/i,
  );
  if (!sizeMatch) return result;
  const prefix = cleaned.slice(0, sizeMatch.index ?? 0).trim();
  const sizeToken = sizeMatch[1]!.trim();
  const familyToken = sizeMatch[2]!.trim();
  if (sizeToken) result["font-size"] = sizeToken;
  if (familyToken) result["font-family"] = familyToken;
  if (prefix) {
    for (const token of prefix.split(/\s+/)) {
      const lower = token.toLowerCase();
      if (lower === "italic" || lower === "oblique") {
        result["font-style"] = lower;
      } else if (lower === "bold" || lower === "bolder" || lower === "lighter" || /^(?:100|200|300|400|500|600|700|800|900)$/.test(lower)) {
        result["font-weight"] = lower;
      }
    }
  }
  return result;
}

export function parseStyleDeclarations(style: string | undefined): Array<[string, string]> {
  if (!style) return [];
  const declarations: Array<[string, string]> = [];
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i <= style.length; i++) {
    const ch = style[i];
    if (quote) {
      if (ch === quote && style[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ";" || i === style.length) {
      const segment = style.slice(start, i).trim();
      start = i + 1;
      if (!segment) continue;
      const colon = segment.indexOf(":");
      if (colon <= 0) continue;
      const prop = segment.slice(0, colon).trim().toLowerCase();
      const val = segment.slice(colon + 1).trim();
      if (prop && val) declarations.push([prop, val]);
    }
  }
  return declarations;
}

export function extractInheritedFromDeclarations(declarations: Array<[string, string]>): InheritedStyle {
  const out: InheritedStyle = {};
  for (const [prop, rawVal] of declarations) {
    const val = rawVal.replace(/\s*!important\s*$/i, "").trim();
    if (!val) continue;
    if (prop === "font") {
      const parsed = extractFontShorthand(val);
      if (parsed["font-family"]) out["font-family"] = parsed["font-family"];
      if (parsed["font-weight"]) out["font-weight"] = parsed["font-weight"];
      if (parsed["font-style"]) out["font-style"] = parsed["font-style"];
      if (parsed["font-size"]) out["font-size"] = parsed["font-size"];
    } else if (
      prop === "font-family" ||
      prop === "font-weight" ||
      prop === "font-style" ||
      prop === "font-size" ||
      prop === "letter-spacing" ||
      prop === "fill"
    ) {
      out[prop] = val;
    }
  }
  return out;
}

const setting = (attributes: Record<string, string>, name: string, preview: string, fallback?: number) => {
  const raw = attributes[name];
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(raw)) {
    throw new Error(`Textbox for "${preview}" needs a finite ${name}`);
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) throw new Error(`Textbox for "${preview}" needs a finite ${name}`);
  return value;
};

function parseNumericFontSize(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s*!important\s*$/i, "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(cleaned)) return undefined;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function renderTextbox(
  attributes: Record<string, string>,
  text: string,
  measure: MeasureText,
  inherited?: InheritedStyle,
  boxIndex?: number,
): string {
  const preview = cleanPreview(text);
  const x = setting(attributes, "x", preview, 0);
  const y = setting(attributes, "y", preview, 0);
  const width = setting(attributes, "width", preview);
  const height = setting(attributes, "height", preview);
  const ownDecls = parseStyleDeclarations(attributes.style);
  const ownStyleInherited = extractInheritedFromDeclarations(ownDecls);

  const fallbackFontSize =
    parseNumericFontSize(ownStyleInherited["font-size"]) ??
    parseNumericFontSize(inherited?.["font-size"]) ??
    16;

  const maximum = setting(attributes, "font-size", preview, fallbackFontSize);
  const floor = Math.min(8, maximum);
  const minimum = Math.max(floor, setting(attributes, "min-font-size", preview, maximum * 0.6));
  const lineHeight = setting(attributes, "line-height", preview, 1.2);
  const align = attributes.align ?? "start";
  const valign = attributes.valign ?? "middle";
  if (width <= 0 || height <= 0 || maximum <= 0 || minimum > maximum || lineHeight <= 0 ||
      !["start", "middle", "end"].includes(align) || !["top", "middle", "bottom"].includes(valign)) {
    throw new Error(
      `Invalid textbox at (x=${x}, y=${y}, ${width}x${height}) for "${preview}": invalid dimensions, font sizes, line height or alignment`,
    );
  }
  if (!text.trim()) return "";

  const boxRefParts = [
    ...(boxIndex !== undefined ? [`#${boxIndex}`] : []),
    ...(attributes.id ? [`id="${attributes.id}"`] : []),
    `x=${x}, y=${y}, ${width}x${height}`,
  ];
  const boxLabel = `textbox (${boxRefParts.join(", ")})`;
  const safeMeasure: MeasureText = (value, font, fontSize) => {
    try {
      return measure(value, font, fontSize);
    } catch (err) {
      if (err instanceof Error && err.message.includes("measurement budget")) {
        throw new Error(`SVG textbox layout exceeds the measurement budget at ${boxLabel} for "${preview}"`);
      }
      throw err;
    }
  };

  const fontFamily = ownStyleInherited["font-family"] ?? attributes["font-family"] ?? inherited?.["font-family"] ?? "Noto Sans";
  const fontWeight = ownStyleInherited["font-weight"] ?? attributes["font-weight"] ?? inherited?.["font-weight"] ?? "normal";
  const fontStyle = ownStyleInherited["font-style"] ?? attributes["font-style"] ?? inherited?.["font-style"] ?? "normal";
  const letterSpacingRaw = ownStyleInherited["letter-spacing"] ?? attributes["letter-spacing"] ?? inherited?.["letter-spacing"];
  const hasLetterSpacing = letterSpacingRaw !== undefined && letterSpacingRaw.trim() !== "" && letterSpacingRaw.trim().toLowerCase() !== "normal";
  const letterSpacing = hasLetterSpacing ? letterSpacingRaw!.trim() : undefined;
  const fill = ownStyleInherited.fill ?? attributes.fill ?? inherited?.fill;

  const baseFontAttrs = ` font-family="${escapeXml(fontFamily)}" font-weight="${escapeXml(fontWeight)}" font-style="${escapeXml(fontStyle)}"`;
  const measureFontAttrs = letterSpacing !== undefined
    ? `${baseFontAttrs} letter-spacing="${escapeXml(letterSpacing)}"`
    : baseFontAttrs;

  // Non-zero px letter-spacing does not scale linearly with font-size, so measure directly at candidate size.
  const fixedPxLetterSpacing = letterSpacing !== undefined &&
    /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(letterSpacing) &&
    Number.parseFloat(letterSpacing) !== 0;

  const cached = new Map<string, Box>();
  const empty: Box = { x: 0, y: 0, width: 0, height: 0 };

  const boundsAt = (value: string, size: number): { x: number; y: number; width: number; height: number } => {
    if (fixedPxLetterSpacing) {
      const rounded = Math.round(size * 100) / 100;
      const key = `${rounded}\0${value}`;
      let box = cached.get(key);
      if (!box) {
        box = safeMeasure(value, measureFontAttrs, rounded) ?? empty;
        cached.set(key, box);
      }
      return box;
    }
    let box = cached.get(value);
    if (!box) {
      box = safeMeasure(value, measureFontAttrs, referenceSize) ?? empty;
      cached.set(value, box);
    }
    const scale = size / referenceSize;
    return { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale };
  };

  const fits = (value: string, size: number) => boundsAt(value, size).width <= width * margin;
  const paragraphs = text.replace(/\r\n?/g, "\n").split("\n");
  const hasExplicitBreaks = paragraphs.length > 1;
  const tokenize = (segment: string) =>
    segment.length === 0 ? [] : (segment.match(/[^\s\-/,]*[\s\-/,]+|[^\s\-/,]+$/gu) ?? [segment]);
  const paragraphTokens = paragraphs.map(tokenize);

  function wrap(size: number, units: string[]) {
    const lines: string[] = [];
    let line = "";
    for (const unit of units) {
      if (fits(line + unit, size)) {
        line += unit;
        continue;
      }
      if (!line || !fits(unit, size)) return;
      lines.push(line);
      line = unit;
    }
    lines.push(line);
    return lines;
  }

  function wrapParagraphs(size: number, groupedUnits: string[][]) {
    const lines: string[] = [];
    for (const units of groupedUnits) {
      if (units.length === 0) {
        lines.push("");
        continue;
      }
      const wrappedPara = wrap(size, units);
      if (!wrappedPara) return;
      lines.push(...wrappedPara);
    }
    return lines;
  }

  function layout(lines: string[], size: number) {
    const boxes = lines.map((line, index) => {
      if (!line.trim()) {
        return { line, index, x: 0, width: 0, top: index * size * lineHeight, height: 0 };
      }
      const box = boundsAt(line, size);
      return { line, index, x: box.x, width: box.width, top: box.y + index * size * lineHeight, height: box.height };
    });
    const nonEmpty = boxes.filter(box => box.line.trim().length > 0);
    const measured = nonEmpty.length > 0 ? nonEmpty : boxes;
    const top = Math.min(...measured.map(box => box.top));
    const bottom = Math.max(...measured.map(box => box.top + box.height));
    if (bottom - top > height * margin) return;
    return { boxes, top, height: bottom - top, size };
  }

  function wrapped(groupedUnits: string[][], low: number, high: number) {
    const at = (size: number) => {
      const lines = wrapParagraphs(size, groupedUnits);
      return lines && layout(lines, size);
    };
    let best = at(low);
    if (!best) return;
    const largest = at(high);
    if (largest) return largest;
    while (high - low > 0.25) {
      const middle = (low + high) / 2;
      const next = at(middle);
      if (next) {
        best = next;
        low = middle;
      } else high = middle;
    }
    return best;
  }

  let result: ReturnType<typeof layout>;
  if (hasExplicitBreaks) {
    result = wrapped(paragraphTokens, minimum, maximum);
  } else if (fixedPxLetterSpacing) {
    result = wrapped([[text]], minimum, maximum) ?? wrapped(paragraphTokens, minimum, maximum);
  } else {
    const full = boundsAt(text, referenceSize);
    const single = Math.min(maximum, width * margin * referenceSize / (full.width || 1),
      height * margin * referenceSize / (full.height || 1));
    result = single >= minimum ? layout([text], single) : wrapped(paragraphTokens, minimum, maximum);
  }
  if (!result && floor < minimum) result = wrapped(paragraphTokens, floor, minimum);
  if (!result) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const brokenParagraphs = paragraphTokens.map(units =>
      units.flatMap(token => fits(token, floor) ? [token]
        : Array.from(segmenter.segment(token), ({ segment }) => segment)),
    );
    const lines = wrapParagraphs(floor, brokenParagraphs);
    result = lines && layout(lines, floor);
  }
  if (!result) {
    throw new Error(`Textbox at (x=${x}, y=${y}, ${width}x${height}) for "${preview}" is too small to fit its text`);
  }

  const { boxes, size } = result;
  const valignFactor = valign === "top" ? 0 : valign === "bottom" ? 1 : 0.5;
  const metricRef = safeMeasure(metricSample, baseFontAttrs, referenceSize);
  let top: number;
  if (metricRef && metricRef.height > 0) {
    const scale = size / referenceSize;
    const metricTop = metricRef.y * scale;
    const metricBottom = (metricRef.y + metricRef.height) * scale;
    const blockMetricHeight = (metricBottom - metricTop) + (boxes.length - 1) * size * lineHeight;
    const idealTop = y - metricTop + (height - blockMetricHeight) * valignFactor;
    const minTop = y - result.top;
    const maxTop = y + height - (result.top + result.height);
    top = Math.min(maxTop, Math.max(minTop, idealTop));
  } else {
    top = y - result.top + (height - result.height) * valignFactor;
  }

  const extraAttrs = PASS_THROUGH_VISUAL_ATTRS.flatMap(name =>
    attributes[name] === undefined ? [] : [` ${name}="${escapeXml(attributes[name]!)}"`],
  ).join("");

  const preservedStyleDecls = ownDecls
    .filter(([prop]) => !LOCKED_STYLE_PROPS.has(prop))
    .map(([prop, val]) => `${prop}:${val}`);

  const lockedLayoutDecls = [
    `font-size:${size}px`,
    `font-family:${fontFamily}`,
    `font-weight:${fontWeight}`,
    `font-style:${fontStyle}`,
    "text-anchor:start",
    `letter-spacing:${letterSpacing ?? "normal"}`,
    "dominant-baseline:auto",
    "alignment-baseline:auto",
    "word-spacing:0",
    "writing-mode:horizontal-tb",
  ];
  const tspanLockedStyle = lockedLayoutDecls.join(";");
  const mergedStyle = [
    ...preservedStyleDecls,
    ...lockedLayoutDecls,
    ...(fill !== undefined ? [`fill:${fill}`] : []),
  ].join(";");
  const fillAttr = fill === undefined ? "" : ` fill="${escapeXml(fill)}"`;

  return `<text${measureFontAttrs}${fillAttr} font-size="${size}" text-anchor="start"${extraAttrs} style="${escapeXml(mergedStyle)}" xml:space="preserve">` +
    boxes.filter(box => box.line.trim().length > 0).map(box => {
      const left = x - box.x + (width - box.width) * (align === "start" ? 0 : align === "end" ? 1 : 0.5);
      return `<tspan x="${left}" y="${top + box.index * size * lineHeight}" style="${escapeXml(tspanLockedStyle)}">${escapeXml(box.line)}</tspan>`;
    }).join("") + "</text>";
}
