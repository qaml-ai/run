import { readFile } from "node:fs/promises";
const packageURL = new URL("../package.json", import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.includes(":")
  ) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return nextResolve(specifier, { ...context, parentURL: packageURL });
    }
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.endsWith("/tests/runtime-server.ts")) {
    const source =
      (await readFile(new URL(url), "utf8"))
        .replace('import { testDatabase } from "./database.ts";', "")
        .replace(
          "export async function runtime(",
          "async function legacyRuntime(",
        ) +
      `\nexport { compatibilityRuntime as runtime } from ${JSON.stringify(new URL("./compat-runtime.ts", import.meta.url).href)};\n`;
    return { format: "module-typescript", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
