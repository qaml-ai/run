import { posix } from "node:path";
import type { Problem } from "../lib/projects.ts";
import type { Files } from "../lib/versions.ts";

export const LIMITS = { files: 200, bytes: 5 * 1024 * 1024 };

/**
 * A site can be published when it has an index.html, every local link and asset in its HTML and CSS is one of its
 * files, and it fits the limits. External URLs are left alone.
 */
export async function validateSite(files: Files): Promise<{ problems: Problem[] }> {
  const problems: Problem[] = [];
  const bytes = [...files.values()].reduce((sum, data) => sum + data.length, 0);
  if (files.size > LIMITS.files) problems.push({ message: `${files.size} files: a site has at most ${LIMITS.files}` });
  if (bytes > LIMITS.bytes) problems.push({ message: `${(bytes / 1024 / 1024).toFixed(1)} MB: a site is at most ${LIMITS.bytes / 1024 / 1024} MB` });
  if (!files.has("index.html")) problems.push({ path: "index.html", message: "Missing: the site's home page" });
  for (const [path, data] of files) {
    for (const ref of references(path, new TextDecoder().decode(data))) {
      if (/^\/(?!\/)/.test(ref)) { problems.push({ path, message: `Refers to ${ref}: use a relative link (the site is served under its own path)` }); continue; }
      const target = resolve(path, ref);
      if (target !== null && !files.has(target)) problems.push({ path, message: `Refers to ${ref}, but there is no ${target}` });
    }
  }
  return { problems: problems.slice(0, 20) };
}

/** The URLs an HTML file's src/href attributes, or a CSS file's url()s and @imports, refer to. */
function references(path: string, text: string): string[] {
  const pattern = path.endsWith(".html") ? /\b(?:src|href)\s*=\s*["']([^"']*)["']/gi
    : path.endsWith(".css") ? /url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi
    : null;
  return pattern ? [...text.matchAll(pattern)].map(match => (match[1] ?? match[2]).trim()) : [];
}

/** The file a reference points to within the site, or null when it points outside it (a URL, an anchor, data:). */
function resolve(from: string, ref: string): string | null {
  if (ref === "" || ref.startsWith("#") || ref.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  let path = ref.split(/[?#]/)[0];
  try { path = decodeURI(path); } catch {}
  if (path === "") return null;
  path = posix.join(posix.dirname(from), path);
  if (path === "" || path.endsWith("/")) path += "index.html";
  return posix.normalize(path);
}
