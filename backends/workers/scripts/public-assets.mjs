import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

/** Package the same documents as the Node server, without runtime filesystem access. */
export async function publicAssets(directory, options = {}) {
  await mkdir(directory, { recursive: true });
  const docs = options.docs ?? resolve(repository, "docs");
  await cp(docs, resolve(directory, "docs"), { recursive: true });
  for (const name of ["llms.txt", "llms-full.txt", "SKILL.md"]) {
    try { await cp(resolve(docs, name), resolve(directory, name)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try { await cp(resolve(docs, "SKILL.md"), resolve(directory, "skill.md")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const registry = options.registry ?? resolve(repository, "packages/registry/public/r");
  try { await cp(registry, resolve(directory, "r"), { recursive: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (options.console) {
    try { await cp(options.console, resolve(directory, "console"), { recursive: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (options.requireConsole) throw new Error(`The console is not built (${options.console} is missing). Run \`npm run build:console\` at the repository root.`);
    }
  } else if (options.requireConsole) throw new Error("A console directory is required");
  // Wrangler serves _headers as configuration. These assets are only read by the Worker.
  await writeFile(resolve(directory, "_headers"), "/*\n  Cache-Control: no-store\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A deploy always ships the console; a missing build fails loudly. Set PUBLIC_ASSETS_WITHOUT_CONSOLE=1 only for a local run that does not need it.
  const optional = process.env.PUBLIC_ASSETS_WITHOUT_CONSOLE === "1";
  await publicAssets(fileURLToPath(new URL("../.assets", import.meta.url)), { console: resolve(repository, "console/dist"), requireConsole: !optional });
}
