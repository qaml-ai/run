/** File and image attachment budgets enforced across runs, history imports, and tool results. */
export const FILE_LIMITS = Object.freeze({
  /** Files attached to one message, and their inline (base64) bytes in all, decoded. */
  attachments: 20, inlineBytes: 4 * 1024 * 1024,
  /** An image the model sees natively: Anthropic's per-image cap, and the longest side any provider takes. */
  imageBytes: 5 * 1024 * 1024, imageSide: 8000,
  /**
   * An image as a model request carries it; a larger one is scaled down first. Anthropic scales a side
   * past 1,568 px down anyway, and refuses sides over 2,000 px once a request holds more than 20 images; base64 of
   * the bytes stays within its 5 MB.
   */
  requestImageSide: 1568, requestImageBytes: 3.75 * 1024 * 1024,
  /** A PDF the model sees natively (Anthropic's page cap; well under every provider's size cap). */
  documentBytes: 16 * 1024 * 1024, documentPages: 100,
  /**
   * Across one model request, newest first: PDFs up to `requestFileBytes` as stored; images,
   * inline or from files, up to `requestImages` (`requestAnthropicImages` for Anthropic) and
   * `requestImageBase64Bytes` as sent (base64, after scaling down),
   * within OpenRouter's 30 MB of image content a request (past it, a 413). Older ones are described in text instead.
   */
  requestFileBytes: 24 * 1024 * 1024, requestImages: 40, requestAnthropicImages: 90, requestImageBase64Bytes: 20 * 1024 * 1024,
  /** File bytes kept hydrated between model requests. */
  hydratedBytes: 32 * 1024 * 1024,
  /** Parsing untrusted files: input, time, memory and text out. */
  inspectBytes: 32 * 1024 * 1024, inspectMs: 10_000, inspectHeapMb: 256, inspectMemoryBytes: 512 * 1024 * 1024, extractedChars: 1_000_000,
  /** A text file's first lines, as its reference carries them: read from at most this many bytes, lines cut to a width. */
  headBytes: 1024, headLines: 5, headWidth: 200,
  /** Signed links: default and longest lifetime, in seconds. */
  linkSeconds: 15 * 60, maxLinkSeconds: 24 * 60 * 60,
  /** A file attached by URL: at most this large, fetched within this long, following at most this many redirects. */
  urlBytes: 64 * 1024 * 1024, urlMs: 60_000, urlRedirects: 3,
  /** An upload's whole request may take this long. */
  uploadMs: 15 * 60_000,
  /** The most of a long tool result saved to the workspace, with its path within a 1 MiB tool result. */
  scriptFileBytes: 700 * 1024,
});
