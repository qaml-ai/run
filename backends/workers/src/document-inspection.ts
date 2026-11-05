import { getDocumentProxy } from "unpdf";
import { FILE_LIMITS } from "../../../src/limits.ts";
import type { Media } from "./attachment-policy.ts";

/** PDF.js's serverless build needs no native code, fonts, network, or eval. */
export async function inspectDocument(bytes: Uint8Array): Promise<Media> {
  if (bytes.length > FILE_LIMITS.documentBytes)
    return { kind: "none", reason: `larger than ${FILE_LIMITS.documentBytes} bytes` };
  try {
    const document = await getDocumentProxy(bytes.slice(), {
      isEvalSupported: false, useSystemFonts: false, verbosity: 0,
      disableFontFace: true, maxImageSize: 0,
    } as never);
    try {
      return { kind: "pdf", pages: document.numPages };
    } finally { await document.destroy(); }
  } catch {
    return { kind: "none", reason: "could not be read (damaged or incomplete PDF)" };
  }
}
