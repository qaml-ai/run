// Starts a throwaway camelFS tier (camelfsd api on DynamoDB Local, with a test Ed25519 key that exists only for this
// run) and runs the shared refs contract (tests/camelfs-refs-contract.test.ts) against it, so the strict fake and the real
// tier run the same cases. CI runs it in the camelfsd job, whose DynamoDB Local service is on CAMELFS_DDB_LOCAL.
//   CAMELFSD_BIN=… CAMELFS_DDB_LOCAL=http://127.0.0.1:8000 node --experimental-strip-types tests/camelfs-refs-tier.ts
// Never point it at a shared table or endpoint: it creates and deletes its own uniquely named tables.
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const bin = process.env.CAMELFSD_BIN, endpoint = process.env.CAMELFS_DDB_LOCAL;
if (!bin || !endpoint) throw new Error("set CAMELFSD_BIN and CAMELFS_DDB_LOCAL");
const exec = promisify(execFile);
const aws = (...args: string[]) => exec("aws", ["dynamodb", ...args, "--endpoint-url", endpoint, "--region", "us-west-2"], {
  env: { ...process.env, AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local" },
});

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const dir = await mkdtemp(join(tmpdir(), "camelfs-refs-tier-"));
const suffix = randomUUID();
const help = await exec(bin, ["api", "-h"]).catch(error => error as { stdout?: string; stderr?: string });
const supportsMarks = `${help.stdout ?? ""}${help.stderr ?? ""}`.includes("marks-table");
const tables: Record<string, string[]> = { [`refs-${suffix}`]: ["lineage", "name"], [`lineages-${suffix}`]: ["lineage"] };
if (supportsMarks) tables[`marks-${suffix}`] = ["lineage"];
let daemon: ReturnType<typeof spawn> | undefined;
let status = 1;
try {
  for (const [name, keys] of Object.entries(tables)) {
    await aws("create-table", "--table-name", name, "--billing-mode", "PAY_PER_REQUEST",
      "--attribute-definitions", ...keys.map(key => `AttributeName=${key},AttributeType=S`),
      "--key-schema", ...keys.map((key, i) => `AttributeName=${key},KeyType=${i ? "RANGE" : "HASH"}`));
    await aws("wait", "table-exists", "--table-name", name);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = `refs-tier-${suffix}`, issuer = "https://refs-contract.invalid";
  const jwks = join(dir, "jwks.json");
  await writeFile(jwks, JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" }] }));
  const port = await freePort();
  const flags = ["api", "--listen", `127.0.0.1:${port}`, "--data", join(dir, "data"), "--store", join(dir, "store"),
    "--token-issuer", issuer, "--jwks-file", jwks, "--ddb-endpoint", endpoint,
    "--refs-table", `refs-${suffix}`, "--lineages-table", `lineages-${suffix}`,
    ...(supportsMarks ? ["--marks-table", `marks-${suffix}`] : [])];
  daemon = spawn(bin, flags, { env: { ...process.env, AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local", AWS_REGION: "us-west-2" }, stdio: ["ignore", "inherit", "inherit"] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (daemon.exitCode !== null) throw new Error(`camelfsd api exited ${daemon.exitCode}`);
    if ((await fetch(`${url}/v0/health`).catch(() => null))?.ok) break;
    if (i > 100) throw new Error("camelfsd api did not become healthy");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const run = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test",
    "tests/camelfs-refs-contract.test.ts"], {
    stdio: "inherit",
    env: { ...process.env, CAMELFS_CONTRACT_URL: url, CAMELFS_CONTRACT_KID: kid, CAMELFS_CONTRACT_ISS: issuer,
      CAMELFS_CONTRACT_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), CAMELFS_REFS_CONTRACT_REQUIRED: "1" },
  });
  status = await new Promise<number>(resolve => run.on("exit", code => resolve(code ?? 1)));
} finally {
  daemon?.kill("SIGTERM");
  for (const name of Object.keys(tables)) await aws("delete-table", "--table-name", name).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
process.exit(status);
