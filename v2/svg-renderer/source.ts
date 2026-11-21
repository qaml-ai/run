import { Buffer } from "node:buffer";
import { SaxesParser } from "saxes";
import { imageHeader, imageIntact } from "../worker/src/lib/image-header.ts";
import { SVG_RENDER_LIMITS as LIMITS } from "./limits.ts";
import { normalizeMissingGlyphs } from "./fonts/coverage.ts";
import { escapeXml as escape, renderTextbox, type MeasureText } from "./textbox.ts";

const families = new Map([["Sans", "Noto Sans"], ["Serif", "Noto Serif"], ["Mono", "Noto Sans Mono"]]);
const svgNamespace = "http://www.w3.org/2000/svg";
const familyList = (css: string) => css.replace(/(^|,)(\s*)(["']?)(Sans|Serif|Mono)\3(?=\s*(?:,|!important\b|$))/g,
  (_match, start: string, space: string, quote: string, name: string) =>
    start + space + quote + families.get(name) + quote);
const fontCss = (css: string) => css.replace(/(^|[;{])(\s*font-family\s*:\s*)([^;}]+)/gi,
  (_match, start: string, property: string, value: string) => start + property + familyList(value));

function dimension(value: string | undefined): number {
  return value && /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value) ? Number.parseFloat(value) : 0;
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

  let width = 0, height = 0, decodedPixels = 0, elements = 0;
  const parts: string[] = [];
  const stack: string[] = [];
  let textbox: { attributes: Record<string, string>; text: string } | undefined;
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
        if (decodedPixels > LIMITS.imagePixels) throw new Error("SVG image decode budget exceeded");
        attributes[key] = image.href;
      } else if (!value.startsWith("#")) reject();
    }
    if (element === "image" && !Object.keys(attributes).some(key => /(^|:)href$/.test(key))) {
      throw new Error("SVG image references must name an image in files");
    }
    if (name === "textbox") {
      textbox = { attributes, text: "" };
      return;
    }
    parts.push(`<${name}${Object.entries(attributes).map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}>`);
  });
  parser.on("closetag", ({ name }) => {
    stack.pop();
    if (textbox) {
      if (!measure) throw new Error("Textbox layout requires the SVG renderer");
      parts.push(renderTextbox(textbox.attributes, normalizeMissingGlyphs(textbox.text), measure));
      textbox = undefined;
      return;
    }
    parts.push(`</${name}>`);
  });
  const text = (value: string) => {
    if (textbox) textbox.text += value;
    else if (stack.at(-1) === "style") parts.push(escape(fontCss(value)));
    else parts.push(escape(stack.some(element => element === "text") ? normalizeMissingGlyphs(value) : value));
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(svg).close();
  return { svg: parts.join(""), width, height };
}
