export type Box = { x: number; y: number; width: number; height: number };
export type MeasureText = (text: string, font: string) => Box | undefined;
const referenceSize = 100;
const margin = 0.98;

const setting = (attributes: Record<string, string>, name: string, fallback?: number) => {
  const raw = attributes[name];
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(raw)) {
    throw new Error(`Textbox needs a finite ${name}`);
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) throw new Error(`Textbox needs a finite ${name}`);
  return value;
};

export const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function renderTextbox(attributes: Record<string, string>, text: string, measure: MeasureText): string {
  const x = setting(attributes, "x", 0);
  const y = setting(attributes, "y", 0);
  const width = setting(attributes, "width");
  const height = setting(attributes, "height");
  const maximum = setting(attributes, "font-size", 16);
  const floor = Math.min(8, maximum);
  const minimum = Math.max(floor, setting(attributes, "min-font-size", maximum * 0.6));
  const lineHeight = setting(attributes, "line-height", 1.2);
  const align = attributes.align ?? "start";
  const valign = attributes.valign ?? "middle";
  if (width <= 0 || height <= 0 || maximum <= 0 || minimum > maximum || lineHeight <= 0 ||
      !["start", "middle", "end"].includes(align) || !["top", "middle", "bottom"].includes(valign)) {
    throw new Error("Invalid textbox dimensions, font sizes, line height or alignment");
  }
  if (!text.trim()) return "";

  const font = ["font-family", "font-weight", "font-style"].flatMap(name =>
    attributes[name] === undefined ? [] : [` ${name}="${escapeXml(attributes[name]!)}"`]).join("");
  const cached = new Map<string, Box>();
  const empty: Box = { x: 0, y: 0, width: 0, height: 0 };
  const bounds = (value: string) => {
    let box = cached.get(value);
    if (!box) {
      box = measure(value, font) ?? empty;
      cached.set(value, box);
    }
    return box;
  };

  const fits = (box: Box, size: number) => box.width * size / referenceSize <= width * margin;
  const full = bounds(text);
  const single = Math.min(maximum, width * margin * referenceSize / (full.width || 1),
    height * margin * referenceSize / (full.height || 1));
  const tokens = text.match(/[^\s\-/,]*[\s\-/,]+|[^\s\-/,]+$/gu) ?? [text];

  function wrap(size: number, units: string[]) {
    const lines: string[] = [];
    let line = "";
    for (const unit of units) {
      if (fits(bounds(line + unit), size)) {
        line += unit;
        continue;
      }
      if (!line || !fits(bounds(unit), size)) return;
      lines.push(line);
      line = unit;
    }
    lines.push(line);
    return lines;
  }

  function layout(lines: string[], size: number) {
    const scale = size / referenceSize;
    const boxes = lines.map((line, index) => {
      const box = bounds(line);
      return { line, x: box.x * scale, width: box.width * scale,
        top: box.y * scale + index * size * lineHeight, height: box.height * scale };
    });
    const top = Math.min(...boxes.map(box => box.top));
    const bottom = Math.max(...boxes.map(box => box.top + box.height));
    if (bottom - top > height * margin) return;
    return { boxes, top, height: bottom - top, size };
  }

  function wrapped(units: string[], low: number, high: number) {
    const at = (size: number) => {
      const lines = wrap(size, units);
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

  let result = single >= minimum ? layout([text], single) : wrapped(tokens, minimum, maximum);
  if (!result && floor < minimum) result = wrapped(tokens, floor, minimum);
  if (!result) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const broken = tokens.flatMap(token => fits(bounds(token), floor) ? [token]
      : Array.from(segmenter.segment(token), ({ segment }) => segment));
    const lines = wrap(floor, broken);
    result = lines && layout(lines, floor);
  }
  if (!result) throw new Error("Textbox is too small to fit its text");

  const { boxes, size } = result;
  const top = y - result.top + (height - result.height) * (valign === "top" ? 0 : valign === "bottom" ? 1 : 0.5);
  const fill = attributes.fill === undefined ? "" : ` fill="${escapeXml(attributes.fill)}"`;
  return `<text${font}${fill} font-size="${size}" xml:space="preserve">` +
    boxes.map((box, index) => {
      const left = x - box.x + (width - box.width) * (align === "start" ? 0 : align === "end" ? 1 : 0.5);
      return `<tspan x="${left}" y="${top + index * size * lineHeight}">${escapeXml(box.line)}</tspan>`;
    }).join("") + "</text>";
}
