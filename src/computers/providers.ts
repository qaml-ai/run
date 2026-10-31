import type { Outbound } from "../outbound.ts";

export const PROVIDERS = ["modal", "daytona", "boat", "e2b", "sprites", "browserbase", "browser-use", "tunnel"] as const;
export type Provider = typeof PROVIDERS[number];
export const isBrowserProvider = (provider: string) => provider === "browserbase" || provider === "browser-use";
export type Credentials = Record<string, string>;
export type Reference = { id: string; [key: string]: unknown };
export interface ComputerDriver {
  create(id: string, seconds: number, allocated?: (ref: Reference) => Promise<void>): Promise<Reference>;
  call(ref: Reference, operation: string, args: Record<string, any>): Promise<unknown>;
  close(ref: Reference): Promise<void>;
  dispose?(): void | Promise<void>;
  /** Whether a create failed because the provider refused the credentials (401 or 403), so it made nothing. */
  refused?(error: unknown): boolean;
}
/** A provider's HTTP answer other than success. */
class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Computer provider HTTP ${status}`); this.status = status; }
}
const httpRefused = (error: unknown) => error instanceof ProviderHttpError && (error.status === 401 || error.status === 403);
// Modal's SDK lets nice-grpc's ClientError through; its codes are gRPC's: UNAUTHENTICATED and PERMISSION_DENIED.
const grpcRefused = (error: any) => error?.name === "ClientError" && (error.code === 16 || error.code === 7);
// Capture on the remote disk, then return bounded streams. SDK helpers otherwise
// buffer an arbitrarily large command response in the shared runtime process.
export const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export const bounded = (run: string, before = "") => `d=$(mktemp -d) || exit 1; ${before}${run} >"$d/out" 2>"$d/err"; r=$?; head -c 24001 "$d/out"; head -c 24001 "$d/err" >&2; rm -rf "$d"; exit "$r"`;
export function boundedCommand(command: string) { return bounded(`bash -lc ${quote(command)}`); }
const shell = (args: Record<string, any>) => [boundedCommand(String(args.command)), Number(args.timeoutSeconds ?? 60)] as const;
export const output = (code: number, stdout: string, stderr = "") => ({ exitCode: code, stdout: stdout.slice(0, 24000), stderr: stderr.slice(0, 24000), truncated: stdout.length > 24000 || stderr.length > 24000 });

async function browserCall(ref: Reference, operation: string, args: Record<string, any>) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(String(ref.connectUrl), { timeout: 15000 });
  try {
    const ctx = browser.contexts()[0], page = ctx.pages()[0] ?? await ctx.newPage();
    page.setDefaultTimeout(15000);
    if (operation === "browser_navigate") { if (!/^https?:\/\//.test(args.url)) throw new Error("HTTP(S) URL required"); await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 20000 }); }
    else if (operation === "browser_click") await page.locator(args.selector).click();
    else if (operation === "browser_fill") await page.locator(args.selector).fill(args.text);
    else if (operation === "browser_evaluate") return await page.evaluate(args.expression);
    else if (operation !== "browser_read") throw new Error("Unsupported browser operation");
    return { url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 16000) };
  } finally { await browser.close(); }
}

export type DriverFactory = (provider: Provider, credentials: Credentials, outbound: Outbound) => ComputerDriver | Promise<ComputerDriver>;

export async function driver(provider: Provider, credentials: Credentials, outbound: Outbound): Promise<ComputerDriver> {
  if (provider === "modal") {
    const { ModalClient, NotFoundError: ModalNotFoundError } = await import("modal");
    const client = new ModalClient({ tokenId: credentials.tokenId, tokenSecret: credentials.tokenSecret, maxRetries: 0, timeoutMs: 120000 });
    return {
      dispose() { client.close(); },
      refused: grpcRefused,
      async create(id, seconds, allocated) {
        const app = await client.apps.fromName("camelrun-computers", { createIfMissing: true });
        const image = client.images.fromRegistry("python:3.11-slim").dockerfileCommands(["RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*"]);
        const sb = await client.sandboxes.create(app, image, { name: id, timeoutMs: seconds * 1000, cpu: 1, memoryMiB: 1024 });
        const ref = { id: sb.sandboxId }; await allocated?.(ref); return ref;
      },
      async call(ref, _op, args) {
        const sb = await client.sandboxes.fromId(ref.id), [command, seconds] = shell(args);
        const proc = await sb.exec(["bash", "-lc", command], { timeoutMs: seconds * 1000 });
        const [code, stdout, stderr] = await Promise.all([proc.wait(), proc.stdout.readText(), proc.stderr.readText()]);
        return output(code, stdout, stderr);
      },
      async close(ref) {
        try {
          const sb = await client.sandboxes.fromId(ref.id); await sb.terminate();
          // Modal can take over 30 seconds to publish termination to poll().
          for (const until = Date.now() + 90000; Date.now() < until;) { if (await sb.poll() !== null) return; await new Promise(r => setTimeout(r, 1000)); }
          throw new Error("Computer cleanup not confirmed");
        } catch (error) { if (!(error instanceof ModalNotFoundError)) throw error; }
      },
    };
  }
  if (provider === "daytona") {
    const { Daytona, DaytonaAuthenticationError, DaytonaForbiddenError, DaytonaNotFoundError } = await import("@daytona/sdk");
    const client = new Daytona({ apiKey: credentials.apiKey, apiUrl: "https://app.daytona.io/api", requestTimeoutMs: 30000 });
    return {
      dispose: () => client[Symbol.asyncDispose](),
      refused: error => error instanceof DaytonaAuthenticationError || error instanceof DaytonaForbiddenError,
      async create(id, seconds, allocated) { const sb = await client.create({ name: id, language: "python", ephemeral: true, autoStopInterval: Math.ceil(seconds / 60) }); const ref = { id: sb.id }; await allocated?.(ref); return ref; },
      async call(ref, _op, args) { const [command, seconds] = shell(args); const result = await (await client.get(ref.id)).process.executeCommand(command, undefined, undefined, seconds); return output(result.exitCode, result.result); },
      async close(ref) { try { await client.delete(await client.get(ref.id), 60, true); } catch (error) { if (!(error instanceof DaytonaNotFoundError)) throw error; } },
    };
  }
  if (provider === "e2b") {
    const { Sandbox, AuthenticationError, SandboxError, CommandExitError, NotFoundError: E2BNotFoundError } = await import("e2b");
    return {
      refused: error => error instanceof AuthenticationError || (error instanceof SandboxError && (error as { statusCode?: number }).statusCode === 403),
      async create(id, seconds, allocated) { const sb = await Sandbox.create({ apiKey: credentials.apiKey, timeoutMs: seconds * 1000, secure: true, metadata: { camelrun: id } }); const ref = { id: sb.sandboxId }; await allocated?.(ref); return ref; },
      async call(ref, _op, args) {
        const sb = await Sandbox.connect(ref.id, { apiKey: credentials.apiKey, timeoutMs: Math.max(1, Number(args.remainingSeconds ?? args.timeoutSeconds)) * 1000 }), [command, seconds] = shell(args);
        try { const result = await sb.commands.run(command, { timeoutMs: seconds * 1000 }); return output(result.exitCode, result.stdout, result.stderr); }
        catch (error) { if (error instanceof CommandExitError) return output(error.exitCode, error.stdout, error.stderr); throw error; }
      },
      async close(ref) { try { await Sandbox.kill(ref.id, { apiKey: credentials.apiKey }); } catch (error) { if (!(error instanceof E2BNotFoundError)) throw error; } },
    };
  }
  if (provider === "sprites") {
    const request = async (path: string, method: string, body?: string, exec = false) => {
      const response = await outbound.fetch(`https://api.sprites.dev/v1/sprites${path}`, {
        method, secrets: { Authorization: `Bearer ${credentials.apiKey}` }, headers: { "Content-Type": exec ? "application/octet-stream" : "application/json" },
        body, timeoutMs: exec ? 135000 : 30000, maxBytes: 2 * 1024 * 1024, maxRedirects: 0,
      });
      if (!response.ok) { await response.body?.cancel(); if (method === "DELETE" && response.status === 404) return response; throw new ProviderHttpError(response.status); }
      return response;
    };
    return {
      refused: httpRefused,
      async create(id, _seconds, allocated) {
        const name = id.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/^-+|-+$/g, "") || "camelrun";
        const value = await (await request("", "POST", JSON.stringify({ name }))).json();
        if (typeof value.name !== "string" || value.name !== name) throw new Error("Computer creation did not return its name");
        const ref = { id: name }; await allocated?.(ref); return ref;
      },
      async call(ref, _op, args) {
        const [command, seconds] = shell(args);
        // HTTP frames lack lengths. One ASCII JSON stdout payload survives merged or split frames.
        const script = `import json,subprocess,sys; r=subprocess.run(["timeout","-k","1","${seconds}s","bash","-lc",sys.stdin.read()],capture_output=True); print(json.dumps({"code":r.returncode,"stdout":r.stdout.decode("utf-8","replace"),"stderr":r.stderr.decode("utf-8","replace")}))`;
        const query = new URLSearchParams([["cmd", "python3"], ["cmd", "-c"], ["cmd", script], ["stdin", "true"]]);
        const response = await request(`/${encodeURIComponent(ref.id)}/exec?${query}`, "POST", command, true);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes[0] !== 1 || bytes.at(-2) !== 3 || bytes.at(-1) !== 0) throw new Error("Computer exec response incomplete");
        const result = JSON.parse(bytes.subarray(1, -2).toString("utf8").replaceAll("\x01", ""));
        if (!Number.isInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error("Invalid computer exec response");
        return output(result.code, result.stdout, result.stderr);
      },
      async close(ref) { const response = await request(`/${encodeURIComponent(ref.id)}`, "DELETE"); await response.body?.cancel(); },
    };
  }
  if (provider === "browserbase") {
    const { default: Browserbase } = await import("@browserbasehq/sdk");
    const client = new Browserbase({ apiKey: credentials.apiKey, maxRetries: 0, fetch: async (url, init) => {
      // Normalize SDK headers and let the guarded transport compute the length.
      const headers = new Headers(init?.headers as HeadersInit);
      headers.delete("content-length");
      headers.delete("x-bb-api-key");
      return outbound.fetch(String(url), { method: init?.method, body: init?.body as BodyInit, signal: init?.signal, headers,
        secrets: { "X-BB-API-Key": credentials.apiKey }, timeoutMs: 30000, maxBytes: 1024 * 1024, maxRedirects: 0 });
    } });
    return {
      refused: error => error instanceof Browserbase.AuthenticationError || error instanceof Browserbase.PermissionDeniedError,
      async create(id, seconds, allocated) { const s = await client.sessions.create({ ...(credentials.projectId ? { projectId: credentials.projectId } : {}), api_timeout: seconds, keepAlive: true, userMetadata: { camelrun: id } }); const ref = { id: s.id, connectUrl: s.connectUrl }; await allocated?.(ref); return ref; },
      call: browserCall,
      async close(ref) {
        try {
          if ((await client.sessions.retrieve(ref.id)).status !== "RUNNING") return;
          await client.sessions.update(ref.id, { status: "REQUEST_RELEASE" });
          for (const until = Date.now() + 30000; Date.now() < until;) { if ((await client.sessions.retrieve(ref.id)).status !== "RUNNING") return; await new Promise(r => setTimeout(r, 1000)); }
          throw new Error("Browser cleanup not confirmed");
        } catch (error) { if (!(error instanceof Browserbase.NotFoundError)) throw error; }
      },
    };
  }
  if (provider === "browser-use") {
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await outbound.fetch(`https://api.browser-use.com/api/v4${path}`, {
        method, secrets: { "X-Browser-Use-API-Key": credentials.apiKey }, headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs: 30000, maxBytes: 1024 * 1024, maxRedirects: 0,
      });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new ProviderHttpError(response.status); }
      return await response.json() as any;
    };
    return {
      refused: httpRefused,
      async create(id, seconds, allocated) {
        const value = await request("/browsers", "POST", { timeout: Math.ceil(seconds / 60), metadata: { camelrun: id }, proxyCountryCode: null, enableRecording: false });
        if (!value || typeof value.id !== "string") throw new Error("Browser creation did not return an ID");
        const ref = { id: value.id, connectUrl: value.cdpUrl };
        await allocated?.(ref);
        if (typeof ref.connectUrl !== "string" || !/^(https|wss):\/\//.test(ref.connectUrl)) throw new Error("Browser connection unavailable");
        return ref;
      },
      call: browserCall,
      async close(ref) {
        const path = `/browsers/${encodeURIComponent(ref.id)}`;
        const existing = await request(path);
        if (!existing || existing.status === "stopped") return;
        const result = await request(path, "PATCH", { action: "stop" });
        if (!result || result.status === "stopped") return;
        for (const until = Date.now() + 30000; Date.now() < until;) {
          const current = await request(path);
          if (!current || current.status === "stopped") return;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error("Browser cleanup not confirmed");
      },
    };
  }
  const request = async (path: string, body?: unknown, method = "POST", allowMissing = false) => {
    const base = provider === "boat" ? "https://boat.dev/api/v1" : credentials.url;
    const response = await outbound.fetch(base.replace(/\/$/, "") + path, { method, secrets: { Authorization: `Bearer ${credentials.apiKey}` }, headers: { "Content-Type": "application/json", ...(method === "DELETE" ? { "X-ASCII-Confirm-Delete": path.split("/").at(-1)! } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs: path.endsWith("/commands") || path === "/exec" ? 135000 : 30000, maxBytes: 2 * 1024 * 1024, maxRedirects: 0 });
    if (!response.ok) { await response.body?.cancel(); if ((method === "DELETE" || allowMissing) && response.status === 404) return null; throw new ProviderHttpError(response.status); }
    return response.status === 204 ? {} : await response.json() as any;
  };
  return provider === "tunnel" ? {
    refused: httpRefused,
    async create(id, _seconds, allocated) { const value = await request("/claim", { claim: id }); const ref = { id: value.id, claim: id }; await allocated?.(ref); return ref; },
    async call(ref, _op, args) { const [command, timeout] = shell(args); const r = await request("/exec", { claim: ref.claim, key: args.requestKey, command, timeout }); if (r.error) throw new Error("Remote command outcome uncertain"); return output(r.exit_code, r.stdout, r.stderr); },
    async close(ref) { await request("/close", { claim: ref.claim }); },
  } : {
    refused: httpRefused,
    async create(_id, seconds, allocated) {
      const r = await request("/sandboxes", { type: "small", ttlSeconds: seconds, noEnv: true, snapshots: false, monitoring: false });
      const ref = { id: r.sandbox.id };
      await allocated?.(ref);
      for (const until = Date.now() + 60000; Date.now() < until;) {
        const info = await request(`/sandboxes/${ref.id}`, undefined, "GET");
        if (["ready", "idle", "running"].includes(info.sandbox?.state)) return ref;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await request(`/sandboxes/${ref.id}`, undefined, "DELETE");
      throw new Error("Computer startup timed out");
    },
    async call(ref, _op, args) { const [command, timeout] = shell(args); const r = await request(`/sandboxes/${ref.id}/commands`, { command, timeoutSeconds: timeout }); return output(r.exitCode, r.stdout ?? "", r.stderr ?? ""); },
    async close(ref) {
      await request(`/sandboxes/${ref.id}`, undefined, "DELETE");
      for (const until = Date.now() + 30000; Date.now() < until;) { if (await request(`/sandboxes/${ref.id}`, undefined, "GET", true) === null) return; await new Promise(r => setTimeout(r, 1000)); }
      throw new Error("Computer cleanup not confirmed");
    },
  };
}
