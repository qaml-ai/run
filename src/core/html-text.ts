/** Text from HTML: what a reader sees on a page (web_fetch), or in a snippet (web_search). */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
  if (code[0] === "#") {
    const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  }
  return ENTITIES[code.toLowerCase()] ?? entity;
});

/** The text a reader sees on an HTML page: no scripts, styles or markup, with block breaks kept. */
export function readableText(html: string): { title?: string; text: string } {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head|iframe|canvas|object)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|table|tr|blockquote|pre|form|figure|figcaption|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  const lines = decode(text).split("\n").map(line => line.replace(/[ \t\f\v ]+/g, " ").trim());
  return { ...(title ? { title: decode(title).replace(/\s+/g, " ").trim() } : {}), text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}
