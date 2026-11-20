import { Buffer } from "node:buffer";
import { SaxesParser } from "saxes";
import { imageHeader, imageIntact } from "../../src/image-header.ts";
import { SVG_RENDER_LIMITS as LIMITS } from "./limits.ts";

const families = new Map([["Sans", "Noto Sans"], ["Serif", "Noto Serif"], ["Mono", "Noto Sans Mono"]]);
const svgNamespace = "http://www.w3.org/2000/svg";
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function dimension(value: string | undefined): number {
  return value && /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value) ? Number.parseFloat(value) : 0;
}

export function prepareSvg(svg: unknown, files: unknown) {
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
  const parser = new SaxesParser({ xmlns: false });
  const reject = () => { throw new Error("SVG contains a document declaration or external resource"); };
  parser.on("doctype", reject);
  parser.on("processinginstruction", reject);
  parser.on("opentag", ({ name, attributes }) => {
    if (++elements > 10_000) throw new Error("SVG has too many elements");
    const element = name.replace(/^.*:/, "").toLowerCase();
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
      if (key === "font-family") attributes[key] = families.get(attributes[key]!) ?? attributes[key]!;
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
    parts.push(`<${name}${Object.entries(attributes).map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}>`);
  });
  parser.on("closetag", ({ name }) => parts.push(`</${name}>`));
  const text = (value: string) => parts.push(escape(value));
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(svg).close();
  return { svg: parts.join(""), width, height };
}
