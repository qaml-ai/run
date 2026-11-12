// gitsvc: stock git behind a small auth proxy. One process per shard host; bare repos under ROOT on local NVMe.
//
//   /<repo>.git/{info/refs,git-upload-pack,git-receive-pack}   smart HTTP (v0/v1/v2: the Git-Protocol header is
//                                                              passed through) -> `git http-backend` as CGI
//   /api/repos                     POST {name}                 create (admin)
//   /api/repos/<repo>              DELETE                      delete (admin)
//   /api/repos/<repo>/refs         GET | POST {ref,old,new}    list | compare-and-swap one ref (fork = create a branch)
//   /api/repos/<repo>/tree/<rev>   GET                         `ls-tree -r -l` (seeds a volume object's index)
//   /api/repos/<repo>/blob/<sha>   GET                         one blob (a volume object's cold read)
//   /api/repos/<repo>/commit       POST {branch,parent,message,files:{path: base64|null}}  server-side commit (admin)
//   /api/repos/<repo>/merge        POST {into,from,message}    server-side merge with git's own merge-ort (admin)
//   /api/repos/<repo>/gc           POST {graceMs}              gc + ship + sweep the bucket (admin)
//   /internal/replicate            POST (hook only)            the replication gate (see replicate.ts)
//
// Every request carries a token from token.ts; the proxy is the only thing that decides who may do what.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyToken, tokenFrom, type Scope } from "./token.ts";
import { git, gitRaw, GitError, ZERO } from "./gitexec.ts";
import { Replicator, configureRepo, type RefUpdate } from "./replicate.ts";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../hooks");
const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export type ServerOptions = { root: string; key: string; port?: number; host?: string; replicator?: Replicator };

export async function startServer(options: ServerOptions) {
  const internal = randomBytes(16).toString("hex");
  let replicateUrl = "";
  const gitDir = (repo: string) => join(options.root, `${repo}.git`);
  /** Every git child: hooks from this checkout, the replication gate when a bucket is configured. */
  const gitEnv = (repo: string, extra: Record<string, string> = {}): Record<string, string> => ({
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: HOOKS, GIT_CONFIG_KEY_1: "http.receivepack", GIT_CONFIG_VALUE_1: "true",
    GIT_AUTHOR_NAME: "camelRun", GIT_AUTHOR_EMAIL: "volumes@camelai.com", GIT_COMMITTER_NAME: "camelRun", GIT_COMMITTER_EMAIL: "volumes@camelai.com",
    GITSVC_REPO: repo, GITSVC_INTERNAL: internal, ...(options.replicator ? { GITSVC_REPLICATE_URL: replicateUrl } : {}), ...extra,
  });
  const g = (repo: string, args: string[], extra: { input?: string | Buffer; okCodes?: number[] } = {}) => gitRaw(["--git-dir", gitDir(repo), ...args], { env: gitEnv(repo), ...extra });

  const server = createServer(async (req, res) => {
    try { await handle(req, res); } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message }));
      if (status >= 500) console.error("gitsvc:", error);
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const token = tokenFrom(req.headers.authorization);
    const need = (repo: string, scope: Scope) => {
      if (!REPO.test(repo)) throw Object.assign(new Error("bad repo name"), { status: 400 });
      const claims = verifyToken(options.key, token, repo, scope);
      if (!claims) {
        // git asks for credentials on 401 and retries with basic auth; a bad token is the same answer.
        res.setHeader("www-authenticate", 'Basic realm="gitsvc"');
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      }
      return claims;
    };

    if (url.pathname === "/internal/replicate") {
      if (req.headers["x-gitsvc-internal"] !== internal || !options.replicator) throw Object.assign(new Error("forbidden"), { status: 403 });
      const repo = url.searchParams.get("repo")!, state = url.searchParams.get("state") as "prepared" | "aborted";
      const updates: RefUpdate[] = (await body(req)).toString().split("\n").filter(Boolean).map((line) => { const [old, nw, ref] = line.split(" "); return { old, new: nw, ref }; });
      await options.replicator.sync(gitDir(repo), repo, state, updates);
      res.writeHead(200).end();
      return;
    }

    const smart = url.pathname.match(/^\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (smart) {
      const [, repo, op] = smart;
      const writes = op === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
      const claims = need(repo, writes ? "write" : "read");
      await exists(repo);
      return cgi(req, res, repo, gitEnv(repo, claims.refs ? { GITSVC_REFS: claims.refs.join(",") } : {}));
    }

    const api = url.pathname.match(/^\/api\/repos(?:\/([^/]+)(?:\/(refs|tree|blob|commit|merge|gc)(?:\/(.+))?)?)?$/);
    if (!api) throw Object.assign(new Error("not found"), { status: 404 });
    const [, repoInPath, op, arg] = api;

    if (!repoInPath && req.method === "POST") {
      const { name } = JSON.parse((await body(req)).toString());
      need(name, "admin");
      if (await stat(gitDir(name)).then(() => true, () => false)) return json(res, 409, { error: "exists" });
      await git(["init", "-q", "--bare", "-b", "main", gitDir(name)]);
      await configureRepo(gitDir(name));
      return json(res, 201, { name, remote: `/${name}.git` });
    }
    const repo = repoInPath!;
    if (!op && req.method === "DELETE") {
      need(repo, "admin");
      await rm(gitDir(repo), { recursive: true, force: true });
      return json(res, 200, { deleted: repo }); // the bucket copy is dropped by the sweeper after the tombstone grace
    }
    await exists(repo);

    if (op === "blob" && req.method === "GET") {
      need(repo, "read");
      if (!/^[0-9a-f]{40}$/.test(arg ?? "")) throw Object.assign(new Error("bad sha"), { status: 400 });
      const out = await g(repo, ["cat-file", "blob", arg!], { okCodes: [128] });
      if (out.code) return json(res, 404, { error: "no such blob" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": out.stdout.byteLength }).end(out.stdout);
      return;
    }
    if (op === "tree" && req.method === "GET") {
      need(repo, "read");
      const out = await g(repo, ["ls-tree", "-r", "-t", "-l", "-z", "--", arg ?? "HEAD"], { okCodes: [128] });
      if (out.code) return json(res, 404, { error: "no such tree" });
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(out.stdout);
      return;
    }
    if (op === "refs" && req.method === "GET") {
      need(repo, "read");
      const out = await git(["--git-dir", gitDir(repo), "for-each-ref", "--format=%(refname) %(objectname)"]);
      return json(res, 200, Object.fromEntries(out.split("\n").filter(Boolean).map((l) => l.split(" "))));
    }
    if (op === "refs" && req.method === "POST") {
      need(repo, "admin");
      const { ref, old, new: next } = JSON.parse((await body(req)).toString()) as { ref: string; old: string | null; new: string | null };
      const ok = await cas(repo, ref, old ?? ZERO, next ?? ZERO);
      return json(res, ok ? 200 : 409, ok ? { ref, sha: next } : { error: "ref moved", current: await revParse(repo, ref) });
    }
    if (op === "commit" && req.method === "POST") {
      need(repo, "admin");
      return json(res, ...await commit(repo, JSON.parse((await body(req)).toString())));
    }
    if (op === "merge" && req.method === "POST") {
      need(repo, "admin");
      return json(res, ...await merge(repo, JSON.parse((await body(req)).toString())));
    }
    if (op === "gc" && req.method === "POST") {
      need(repo, "admin");
      const { graceMs = 7 * 86_400_000 } = JSON.parse((await body(req)).toString() || "{}");
      const started = performance.now();
      // --prune keeps unreachable objects younger than the grace: a push in flight may still reference them.
      await g(repo, ["gc", "--quiet", `--prune=${Math.round(graceMs / 1000)}.seconds.ago`]);
      const shipped = options.replicator ? await options.replicator.sync(gitDir(repo), repo, "gc", []) : null;
      const swept = options.replicator ? await options.replicator.sweep(gitDir(repo), repo, graceMs) : 0;
      return json(res, 200, { ms: Math.round(performance.now() - started), shipped, swept });
    }
    throw Object.assign(new Error("not found"), { status: 404 });
  }

  async function exists(repo: string) {
    if (!REPO.test(repo) || !(await stat(gitDir(repo)).then(() => true, () => false))) throw Object.assign(new Error("no such repo"), { status: 404 });
  }
  async function revParse(repo: string, ref: string) {
    const out = await g(repo, ["rev-parse", "--verify", "-q", ref], { okCodes: [1] });
    return out.code ? null : out.stdout.toString().trim();
  }
  /** One ref transaction; the reference-transaction hook gates it on the bucket. false = the ref was not `old`. */
  async function cas(repo: string, ref: string, old: string, next: string, alsoDelete?: string): Promise<boolean> {
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref)) throw Object.assign(new Error("bad ref"), { status: 400 });
    const lines = (next === ZERO ? `delete ${ref} ${old}\n` : `update ${ref} ${next} ${old}\n`) + (alsoDelete ? `delete ${alsoDelete}\n` : "");
    const out = await g(repo, ["update-ref", "--stdin"], { input: lines, okCodes: [128] });
    if (!out.code) return true;
    if (/cannot lock ref|is at .* but expected|reference already exists|unable to resolve reference/.test(out.stderr)) return false;
    throw new GitError(out.code, out.stdout, out.stderr, ["update-ref"]);
  }

  /**
   * A commit built server-side with `git fast-import` (one process, objects land as one pack, no loose objects) on a
   * scratch ref, then moved onto the branch with a CAS on `parent`. This is the code.storage-style write API: a
   * volume object can checkpoint without knowing the pack format at all.
   */
  async function commit(repo: string, input: { branch: string; parent: string | null; message: string; files: Record<string, string | null> }): Promise<[number, unknown]> {
    const scratch = `refs/gitsvc/tmp/${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const chunks: Buffer[] = [];
    const add = (s: string | Buffer) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
    const message = Buffer.from(input.message);
    add(`commit ${scratch}\ncommitter camelRun <volumes@camelai.com> ${now} +0000\ndata ${message.byteLength}\n`); add(message); add("\n");
    if (input.parent) add(`from ${input.parent}\n`);
    for (const [path, content] of Object.entries(input.files)) {
      if (!path || path.includes("\n") || path.startsWith("/") || path.split("/").includes("..")) throw Object.assign(new Error(`bad path ${path}`), { status: 400 });
      if (content === null) { add(`D ${quote(path)}\n`); continue; }
      const bytes = Buffer.from(content, "base64");
      add(`M 100644 inline ${quote(path)}\ndata ${bytes.byteLength}\n`); add(bytes); add("\n");
    }
    add("done\n");
    await g(repo, ["fast-import", "--quiet", "--done"], { input: Buffer.concat(chunks) });
    const sha = (await revParse(repo, scratch))!;
    const ok = await cas(repo, `refs/heads/${input.branch}`, input.parent ?? ZERO, sha, scratch);
    if (!ok) { await g(repo, ["update-ref", "-d", scratch]); return [409, { error: "branch moved", current: await revParse(repo, `refs/heads/${input.branch}`) }]; }
    return [200, { commit: sha, tree: (await revParse(repo, `${sha}^{tree}`)) }];
  }

  /**
   * Merge `from` into `into` with git's merge-ort (`merge-tree --write-tree`, git >= 2.38): renames, directory
   * renames and line-level three-way merges are git's, not ours. Clean -> a two-parent commit, packed, then a CAS on
   * `into`. Conflicts -> nothing moves; the paths and git's messages come back.
   */
  async function merge(repo: string, input: { into: string; from: string; message?: string }): Promise<[number, unknown]> {
    const ours = await revParse(repo, `refs/heads/${input.into}`), theirs = await revParse(repo, `refs/heads/${input.from}`);
    if (!ours || !theirs) return [404, { error: "no such branch" }];
    const out = await g(repo, ["merge-tree", "--write-tree", "-z", "--name-only", ours, theirs], { okCodes: [1] });
    const fields = out.stdout.toString().split("\0");
    if (out.code === 1) {
      const conflicts: string[] = [];
      for (const f of fields.slice(1)) { if (!f) break; conflicts.push(f); }
      return [409, { merged: false, conflicts: [...new Set(conflicts)] }];
    }
    const tree = fields[0].trim();
    const sha = (await g(repo, ["commit-tree", tree, "-p", ours, "-p", theirs, "-m", input.message ?? `merge ${input.from} into ${input.into}`])).stdout.toString().trim();
    // merge-tree and commit-tree write loose objects; pack the new ones so the replication invariant holds.
    const list = await git(["--git-dir", gitDir(repo), "rev-list", "--objects", sha, "--not", ours, theirs]);
    await g(repo, ["pack-objects", "--quiet", join(gitDir(repo), "objects/pack/pack")], { input: list.split("\n").map((l) => l.split(" ")[0]).join("\n") + "\n" });
    const ok = await cas(repo, `refs/heads/${input.into}`, ours, sha);
    if (!ok) return [409, { merged: false, error: "into moved during merge; retry" }];
    return [200, { merged: true, commit: sha, tree }];
  }

  function cgi(req: IncomingMessage, res: ServerResponse, repo: string, env: Record<string, string>) {
    const url = new URL(req.url ?? "/", "http://x");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env, ...env,
        GIT_PROJECT_ROOT: options.root, GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname, QUERY_STRING: url.searchParams.toString(), REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: req.headers["content-length"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""), // protocol v2 when the client asks
        REMOTE_USER: repo, REMOTE_ADDR: req.socket.remoteAddress ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    req.pipe(child.stdin);
    child.stdin.on("error", () => {});
    let head = Buffer.alloc(0), done = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (done) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const i = line.indexOf(":"); const name = line.slice(0, i), value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") status = parseInt(value, 10); else res.setHeader(name, value);
      }
      res.writeHead(status);
      done = true;
      res.write(head.subarray(end + 4));
    });
    child.on("close", (code) => { if (!done) { res.writeHead(500); res.write(stderr); } else if (code && stderr) console.error(`http-backend ${repo}: ${stderr.trim().slice(0, 300)}`); res.end(); });
  }

  server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  replicateUrl = `http://127.0.0.1:${port}/internal/replicate`;
  return { url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host ?? "127.0.0.1"}:${port}`, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function quote(path: string) { return /[\s"\\]/.test(path) ? JSON.stringify(path) : path; }
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); }
async function body(req: IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks); }

// `node src/server.ts` runs a shard: GITSVC_ROOT, GITSVC_KEY, PORT, and S3_* for the replication gate.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const replicator = process.env.S3_BUCKET ? new Replicator({ endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET, accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! }) : undefined;
  const s = await startServer({ root: process.env.GITSVC_ROOT!, key: process.env.GITSVC_KEY!, port: Number(process.env.PORT ?? 8080), host: "0.0.0.0", replicator });
  console.error(`gitsvc on :${s.port} root=${process.env.GITSVC_ROOT} replication=${replicator ? "on" : "off"}`);
}
