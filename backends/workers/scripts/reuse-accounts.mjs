import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = name => readFile(resolve(root, "src", name), "utf8");
const outputs = new Map();
const imports = new Map([
  ["./db.ts", "./postgres.ts"], ["./http.ts", "./account-http.ts"],
  ["./passwords.ts", "./account-passwords.ts"], ["./email-accounts.ts", "./account-email-accounts.ts"],
  ["./console-auth.ts", "./account-console-auth.ts"], ["./signup-source.ts", "./account-signup-source.ts"],
  ["./origins.ts", "./account-origins.ts"], ["./rate-limits.ts", "./account-rate-limits.ts"],
  ["./node-context.ts", "./account-network.ts"], ["./journey.ts", "./account-journey.ts"],
  ["./metrics.ts", "./account-metrics.ts"],
]);
for (const name of ["console-auth.ts", "email-accounts.ts", "passwords.ts", "oauth.ts", "signup-source.ts", "origins.ts", "rate-limits.ts"]) {
  let text = await source(name);
  for (const [from, to] of imports) text = text.replaceAll(`"${from}"`, `"${to}"`);
  if (name === "passwords.ts") {
    text = text.replace('import { readFileSync } from "node:fs";\n', 'import { commonPasswords } from "./account-common-passwords.ts";\n')
      .replace('readFileSync(new URL("./common-passwords.txt", import.meta.url), "utf8")', 'commonPasswords');
  }
  outputs.set(`account-${name}`, `// Generated from src/${name}; infrastructure imports and static asset loading only.\n` + text);
}
outputs.set("account-common-passwords.ts", `// Generated from src/common-passwords.txt; bundled instead of reading a host filesystem.\nexport const commonPasswords = ${JSON.stringify(await source("common-passwords.txt"))};\n`);
const api = await source("api.ts");
const oauthStart = api.indexOf("const OAUTH_ROUTES = [");
const oauthEnd = api.indexOf("\n];", oauthStart);
if (oauthStart < 0 || oauthEnd < 0) throw new Error("OAuth route policy extraction boundary changed");
outputs.set("account-access.ts", `// Generated from src/api.ts; OAuth's public API allowlist is unchanged.\n${api.slice(oauthStart, oauthEnd + 3)}\nexport const oauthAllows = (method: string, path: string) => OAUTH_ROUTES.some(allowed => allowed.test(\`${'${method} ${path}'}\`));\n`);
for (const [name, expected] of outputs) {
  const path = resolve(root, "backends/workers/src", name);
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== expected) throw new Error(`${name} differs from src; regenerate`);
  } else await writeFile(path, expected);
}
console.log("Account, console, OAuth, password, origin and rate-limit policy match src/");
