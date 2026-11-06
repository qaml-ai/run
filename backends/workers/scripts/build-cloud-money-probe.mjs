import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../node_modules/typescript/lib/typescript.js";
const directory = dirname(fileURLToPath(import.meta.url));
const source = await readFile(resolve(directory, "../../../src/accounts.ts"), "utf8");
const methods = source.slice(source.indexOf("  seal(aad: string"), source.indexOf("  async deleteKey("));
if (!methods.includes("createCipheriv") || !methods.includes("unseal")) throw new Error("Source encryption methods changed");
const passwords = await readFile(resolve(directory, "../../../src/passwords.ts"), "utf8");
const passwordMethods = passwords.slice(passwords.indexOf("const COST ="), passwords.indexOf("/** A sign-in address"));
const probe = (await readFile(resolve(directory, "cloud-money-probe.ts"), "utf8"))
  .replace("  /* SOURCE_CRYPTO_METHODS */", methods).replace("/* SOURCE_PASSWORD_METHODS */", passwordMethods);
const { outputText, diagnostics } = ts.transpileModule(probe, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
if (diagnostics?.length) throw new Error("Probe failed to transpile");
await writeFile(process.argv[2] ?? resolve(directory, "../.wrangler/cloud-money-probe.js"), outputText);
console.log("Generated isolated fake-authority probe with source Accounts encryption methods");
