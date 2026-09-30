// @vitest-environment node
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** Minified and gzipped bytes of an entry, with React (and what the budget leaves out) external. */
async function gzipped(entry: string, external: string[]) {
  const result = await build({
    entryPoints: [at(entry)], bundle: true, minify: true, format: "esm", platform: "browser", write: false, logLevel: "silent",
    external: ["react", "react-dom", "react/jsx-runtime", ...external],
    alias: { "@camelai/run/markdown": at("../../../clients/markdown.ts") },
  });
  return gzipSync(result.outputFiles[0].contents).length;
}

describe("bundle size", () => {
  it("the hooks stay under 2 KB, and the components (with markdown) under 14 KB, gzipped", async () => {
    const hooks = await gzipped("../src/index.tsx", ["@camelai/run/chat"]);
    const ui = await gzipped("../src/ui/index.tsx", ["@camelai/run/chat", "../index.tsx"]);
    expect(hooks, `hooks: ${hooks} bytes`).toBeLessThan(2 * 1024);
    expect(ui, `ui: ${ui} bytes`).toBeLessThan(14 * 1024);
    const css = gzipSync(await (await import("node:fs/promises")).readFile(at("../src/ui/styles.css"))).length;
    expect(css, `styles.css: ${css} bytes`).toBeLessThan(4 * 1024);
  });
});
