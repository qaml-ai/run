import { Buffer } from "node:buffer";
import { SaxesParser } from "saxes";
import { imageHeader, imageIntact } from "../worker/src/lib/image-header.ts";
import { SVG_RENDER_LIMITS as LIMITS } from "./limits.ts";
import { normalizeMissingGlyphs } from "./fonts/coverage.ts";
import {
  escapeXml as escape,
  extractInheritedFromDeclarations,
  parseStyleDeclarations,
  renderTextbox,
  type InheritedStyle,
  type MeasureText,
} from "./textbox.ts";

const families = new Map([["Sans", "Noto Sans"], ["Serif", "Noto Serif"], ["Mono", "Noto Sans Mono"]]);
const svgNamespace = "http://www.w3.org/2000/svg";
const familyList = (css: string) => css.replace(/(^|,)(\s*)(["']?)(Sans|Serif|Mono)\3(?=\s*(?:,|!important\b|$))/g,
  (_match, start: string, space: string, quote: string, name: string) =>
    start + space + quote + families.get(name) + quote);

const fontShorthandCss = (value: string) => value.replace(
  /((?:^|\s)(?:(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|ex|ch|vw|vh|vmin|vmax|%|cm|mm|in|pc)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*(?:normal|(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|em|rem|%|cm|mm|in|pc)?))?\s+)(.+)$/i,
  (_match, prefix: string, list: string) => prefix + familyList(list),
);

export const fontCss = (css: string) => css
  .replace(/(^|[;{])(\s*font-family\s*:\s*)([^;}]+)/gi,
    (_match, start: string, property: string, value: string) => start + property + familyList(value))
  .replace(/(^|[;{])(\s*font\s*:\s*)([^;}]+)/gi,
    (_match, start: string, property: string, value: string) => start + property + fontShorthandCss(value));

function dimension(value: string | undefined): number {
  return value && /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value) ? Number.parseFloat(value) : 0;
}

interface CssRule {
  selector: string;
  specificity: readonly [number, number, number];
  style: InheritedStyle;
}

function selectorSpecificity(selector: string): readonly [number, number, number] {
  let ids = 0, classes = 0, tags = 0;
  for (const part of selector.trim().split(/\s+/)) {
    if (!part || part === "*") continue;
    if (/^[a-zA-Z][a-zA-Z0-9_-]*/.test(part)) tags++;
    ids += (part.match(/#[a-zA-Z0-9_-]+/g) ?? []).length;
    classes += (part.match(/\.[a-zA-Z0-9_-]+/g) ?? []).length;
  }
  return [ids, classes, tags];
}

function parseSimpleCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of stripped.matchAll(blockRe)) {
    const selectorList = match[1]!.trim();
    const body = match[2]!.trim();
    if (!selectorList || !body || selectorList.startsWith("@")) continue;
    const style = extractInheritedFromDeclarations(parseStyleDeclarations(body));
    if (Object.keys(style).length === 0) continue;
    for (const rawSelector of selectorList.split(",")) {
      const selector = rawSelector.trim();
      if (selector) rules.push({ selector, specificity: selectorSpecificity(selector), style });
    }
  }
  return rules;
}

function collectDocumentCssRules(svg: string): CssRule[] {
  if (!/<(?:[a-zA-Z0-9_-]+:)?style[\s>]/i.test(svg)) return [];
  const rules: CssRule[] = [];
  let inStyle = false;
  let styleBuf = "";
  const scanner = new SaxesParser({ xmlns: false });
  scanner.on("opentag", ({ name }) => {
    if (name.replace(/^.*:/, "").toLowerCase() === "style") {
      inStyle = true;
      styleBuf = "";
    }
  });
  scanner.on("closetag", ({ name }) => {
    if (name.replace(/^.*:/, "").toLowerCase() === "style" && inStyle) {
      rules.push(...parseSimpleCssRules(fontCss(styleBuf)));
      inStyle = false;
      styleBuf = "";
    }
  });
  const onText = (value: string) => {
    if (inStyle) styleBuf += value;
  };
  scanner.on("text", onText);
  scanner.on("cdata", onText);
  try {
    scanner.write(svg).close();
  } catch {
    // Let the main parser surface XML syntax errors cleanly.
  }
  return rules;
}

interface ElementNode {
  tag: string;
  classes: Set<string>;
  id: string | undefined;
}

function matchesCompoundSelector(
  compound: string,
  tags: string[],
  classes: Set<string>,
  id: string | undefined,
): boolean {
  if (!compound) return false;
  if (compound === "*") return true;
  if (/[>+~[:*]/.test(compound)) return false;
  const tagMatch = compound.match(/^[a-zA-Z][a-zA-Z0-9_-]*/);
  if (tagMatch) {
    const selTag = tagMatch[0].toLowerCase();
    if (!tags.includes(selTag)) return false;
  }
  for (const idMatch of compound.matchAll(/#([a-zA-Z0-9_-]+)/g)) {
    if (id !== idMatch[1]) return false;
  }
  for (const classMatch of compound.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!classes.has(classMatch[1]!)) return false;
  }
  return true;
}

function matchesSimpleSelector(
  selector: string,
  tags: string[],
  classes: Set<string>,
  id: string | undefined,
  ancestors: ElementNode[],
): boolean {
  const parts = selector.trim().split(/\s+/);
  if (parts.length === 0) return false;
  if (!matchesCompoundSelector(parts[parts.length - 1]!, tags, classes, id)) return false;
  if (parts.length === 1) return true;
  // Walk ancestors backwards matching remaining descendant selector parts.
  let ancIdx = ancestors.length - 1;
  for (let p = parts.length - 2; p >= 0; p--) {
    let matched = false;
    while (ancIdx >= 0) {
      const anc = ancestors[ancIdx]!;
      ancIdx--;
      if (matchesCompoundSelector(parts[p]!, [anc.tag], anc.classes, anc.id)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function resolveCssForElement(
  rules: CssRule[],
  tags: string[],
  attributes: Record<string, string>,
  ancestors: ElementNode[],
): InheritedStyle {
  if (rules.length === 0) return {};
  const classes = new Set((attributes.class ?? "").trim().split(/\s+/).filter(Boolean));
  const id = attributes.id;
  const matched: Array<{ rule: CssRule; order: number }> = [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (matchesSimpleSelector(rule.selector, tags, classes, id, ancestors)) {
      matched.push({ rule, order: i });
    }
  }
  matched.sort((a, b) =>
    (a.rule.specificity[0] - b.rule.specificity[0]) ||
    (a.rule.specificity[1] - b.rule.specificity[1]) ||
    (a.rule.specificity[2] - b.rule.specificity[2]) ||
    (a.order - b.order),
  );
  const resolved: InheritedStyle = {};
  for (const { rule } of matched) Object.assign(resolved, rule.style);
  return resolved;
}

function ownPresentationInherited(attributes: Record<string, string>): InheritedStyle {
  const out: InheritedStyle = {};
  if (attributes["font-family"] !== undefined) out["font-family"] = attributes["font-family"];
  if (attributes["font-weight"] !== undefined) out["font-weight"] = attributes["font-weight"];
  if (attributes["font-style"] !== undefined) out["font-style"] = attributes["font-style"];
  if (attributes["font-size"] !== undefined) out["font-size"] = attributes["font-size"];
  if (attributes["letter-spacing"] !== undefined) out["letter-spacing"] = attributes["letter-spacing"];
  if (attributes.fill !== undefined) out.fill = attributes.fill;
  Object.assign(out, extractInheritedFromDeclarations(parseStyleDeclarations(attributes.style)));
  return out;
}

export function prepareSvg(svg: unknown, files: unknown, measure?: MeasureText) {
  if (typeof svg !== "string" || !svg.trim() || Buffer.byteLength(svg) > LIMITS.svgBytes) {
    throw new Error("Supply a non-empty SVG up to 1 MiB");
  }
  if (files !== undefined && (!files || typeof files !== "object" || Array.isArray(files))) {
    throw new Error("files must map names to inline raster images");
  }
  const entries = Object.entries(files ?? {});
  if (entries.length > LIMITS.imageCount) throw new Error("Too many SVG input images");
  const images = new Map<string, { href: string; pixels: number }>();
  let inputBytes = 0;
  for (const [name, file] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || !file || typeof file?.data !== "string") {
      throw new Error("Each image needs a simple name and base64 data");
    }
    inputBytes += file.data.length;
    if (inputBytes > LIMITS.imageBase64Bytes) throw new Error("SVG image byte budget exceeded");
    const bytes = Buffer.from(file.data, "base64");
    const header = imageHeader(bytes);
    if (!header?.width || !header.height || !["image/png", "image/jpeg"].includes(header.mimeType) ||
        bytes.length > LIMITS.imageBytes || Math.max(header.width, header.height) > LIMITS.imageSide ||
        bytes.toString("base64") !== file.data || !imageIntact(bytes, header.mimeType)) {
      throw new Error("SVG files must be valid PNG or JPEG within the image limits");
    }
    images.set(name, { href: `data:${header.mimeType};base64,${file.data}`, pixels: header.width * header.height });
  }

  let width = 0, height = 0, decodedPixels = 0, elements = 0, textboxCount = 0;
  const parts: string[] = [];
  const stack: string[] = [];
  const elementStack: ElementNode[] = [];
  const styleStack: InheritedStyle[] = [];
  const cssRules: CssRule[] = collectDocumentCssRules(svg);
  let textbox: { attributes: Record<string, string>; text: string; inherited: InheritedStyle; index: number } | undefined;
  const parser = new SaxesParser({ xmlns: false });
  const reject = () => { throw new Error("SVG contains a document declaration or external resource"); };
  parser.on("doctype", reject);
  parser.on("processinginstruction", reject);
  parser.on("opentag", ({ name, attributes }) => {
    if (++elements > 10_000) throw new Error("SVG has too many elements");
    const element = name.replace(/^.*:/, "").toLowerCase();
    if (textbox) throw new Error("Textbox content must be plain text");
    stack.push(element);
    if (["script", "foreignobject", "feimage"].includes(element)) reject();

    if (elements === 1) {
      if (name !== "svg" || attributes.xmlns && attributes.xmlns !== svgNamespace) throw new Error("Expected an SVG root element");
      const viewBox = attributes.viewBox?.trim().split(/[\s,]+/).map(Number);
      width = Math.ceil(dimension(attributes.width) || (viewBox?.length === 4 ? viewBox[2]! : 0));
      height = Math.ceil(dimension(attributes.height) || (viewBox?.length === 4 ? viewBox[3]! : 0));
      if (!(width > 0 && height > 0 && Math.max(width, height) <= LIMITS.imageSide && width * height <= LIMITS.pixels)) {
        throw new Error("SVG output needs dimensions within 4 megapixels");
      }
      attributes.width = String(width);
      attributes.height = String(height);
      attributes.xmlns = svgNamespace;
    }
    for (const key of Object.keys(attributes)) {
      if (/^on/i.test(key)) reject();
      if (key === "font-family") attributes[key] = familyList(attributes[key]!);
      if (key === "style") attributes[key] = fontCss(attributes[key]!);
      if (!/(^|:)href$/.test(key)) continue;
      const value = attributes[key]!;
      if (element === "image") {
        const image = images.get(value);
        if (!image) throw new Error("SVG image references must name an image in files");
        decodedPixels += image.pixels;
        if (decodedPixels > LIMITS.imagePixels) {
          throw new Error(`SVG image decode budget exceeded (max ${LIMITS.imagePixels / (1024 * 1024)} megapixels total across embedded images)`);
        }
        attributes[key] = image.href;
      } else if (!value.startsWith("#")) reject();
    }
    if (element === "image" && !Object.keys(attributes).some(key => /(^|:)href$/.test(key))) {
      throw new Error("SVG image references must name an image in files");
    }

    const parentInherited = styleStack.at(-1) ?? {};
    const node: ElementNode = {
      tag: element,
      classes: new Set((attributes.class ?? "").trim().split(/\s+/).filter(Boolean)),
      id: attributes.id,
    };
    if (name === "textbox") {
      // Textbox expands to <text>, so rules targeting `text` or `textbox` (or its class/id) apply on top of inherited parent styles.
      const inherited: InheritedStyle = {
        ...parentInherited,
        ...resolveCssForElement(cssRules, ["text", "textbox"], attributes, elementStack),
      };
      elementStack.push(node);
      styleStack.push(inherited);
      textbox = { attributes, text: "", inherited, index: ++textboxCount };
      return;
    }

    const nextInherited: InheritedStyle = {
      ...parentInherited,
      ...resolveCssForElement(cssRules, [element], attributes, elementStack),
      ...ownPresentationInherited(attributes),
    };
    elementStack.push(node);
    styleStack.push(nextInherited);
    parts.push(`<${name}${Object.entries(attributes).map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}>`);
  });
  parser.on("closetag", ({ name }) => {
    stack.pop();
    elementStack.pop();
    styleStack.pop();
    if (textbox) {
      if (!measure) throw new Error("Textbox layout requires the SVG renderer");
      parts.push(renderTextbox(textbox.attributes, normalizeMissingGlyphs(textbox.text), measure, textbox.inherited, textbox.index));
      textbox = undefined;
      return;
    }
    parts.push(`</${name}>`);
  });
  const text = (value: string) => {
    if (textbox) textbox.text += value;
    else if (stack.at(-1) === "style") {
      parts.push(escape(fontCss(value)));
    } else parts.push(escape(stack.some(element => element === "text") ? normalizeMissingGlyphs(value) : value));
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(svg).close();
  return { svg: parts.join(""), width, height };
}
