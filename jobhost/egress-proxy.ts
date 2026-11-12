// The job host's egress proxy (docs/design/job-hosts-plan.md, slice 6): a job VM's only way out. It runs as its own user
// (PROXY_USER, network.ts), whose traffic the host's rules keep to public addresses on 443, and answers HTTP CONNECT on
// each job tap's host address (PROXY_PORT). A connection is let through only when:
// - its source is a job's guest address, with a policy the host agent wrote for that job (policyDir/<guest ip>.json);
// - the target is <host>:443, and the host is on that policy's allowlist (exact names, or "*.suffix");
// - every address the name resolves to is public. The connection goes to the address the proxy checked, so a name that
//   resolves to IMDS, the VPC or loopback (DNS rebinding) is refused, and the host's rules refuse it again.
// Everything else gets 403 and is logged without its path. Plain HTTP is not proxied: CONNECT only.
//   node --experimental-strip-types jobhost/egress-proxy.ts --policies /run/camel/egress --listen 0.0.0.0
import { createServer, type Server } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { readFile, writeFile, rm, mkdir, rename } from "node:fs/promises";
import { Resolver } from "node:dns/promises";
import { join } from "node:path";
import { PROXY_PORT } from "./network.ts";

/** What a job with internet may reach by default: GitHub and the common package registries, besides the runtime. */
export const DEFAULT_EGRESS = Object.freeze([
  "github.com", "*.github.com", "*.githubusercontent.com", "codeload.github.com",
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "index.crates.io", "static.crates.io",
  "proxy.golang.org", "sum.golang.org",
]);
/** Amazon's DNS resolver, the only one the proxy uses (and the only DNS the host's rules let it reach). */
export const AMAZON_DNS = "169.254.169.253";

export type EgressPolicy = { job: string; allow: string[] };
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Whether `host` is on `allow` (exact names, or "*.suffix" for any name under the suffix, not the suffix itself). */
export function allowed(host: string, allow: readonly string[]) {
  const name = host.toLowerCase();
  if (!HOST.test(name)) return false;
  return allow.some(entry => {
    const rule = entry.toLowerCase();
    return rule.startsWith("*.") ? name.endsWith(rule.slice(1)) && name.length > rule.length - 1 : name === rule;
  });
}

/** Whether an address is public (not private, loopback, link-local, CGNAT, multicast, reserved, or IPv4-mapped). */
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1" || lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:")) return false;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00);
  }
  return false;
}

/** The host agent's side: a job's policy, keyed by its guest address; removed when the job ends. */
export async function writePolicy(policyDir: string, guestIp: string, policy: EgressPolicy) {
  if (isIP(guestIp) !== 4) throw new Error("Invalid guest address");
  await mkdir(policyDir, { recursive: true, mode: 0o755 });
  const file = join(policyDir, `${guestIp}.json`), temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(policy), { mode: 0o644 });
  await rename(temp, file);
}
export async function removePolicy(policyDir: string, guestIp: string) {
  if (isIP(guestIp) === 4) await rm(join(policyDir, `${guestIp}.json`), { force: true });
}

export type ProxyOptions = {
  policyDir: string;
  /** Resolve a name to its addresses (Amazon's resolver by default). */
  lookup?: (host: string) => Promise<string[]>;
  /** Open the upstream connection (tests); a TCP connection by default. */
  dial?: (address: string, port: number) => Socket;
  log?: (line: Record<string, unknown>) => void;
  /** Connections at once per job, and over all jobs, past which new ones are refused. */
  perJob?: number;
  total?: number;
};

const amazonLookup = () => {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  resolver.setServers([AMAZON_DNS]);
  return async (host: string) => {
    const [v4, v6] = await Promise.all([resolver.resolve4(host).catch(() => [] as string[]), resolver.resolve6(host).catch(() => [] as string[])]);
    return [...v4, ...v6];
  };
};

/** The proxy server: CONNECT only, by the policy of the guest it comes from. */
export function egressProxy(options: ProxyOptions): Server {
  const lookup = options.lookup ?? amazonLookup();
  const dial = options.dial ?? ((address, port) => connect({ host: address, port }));
  const log = options.log ?? (line => console.log(JSON.stringify(line)));
  const open = new Map<string, number>();
  let opened = 0;
  const server = createServer((request, response) => {
    // Plain HTTP (not CONNECT) is never proxied.
    response.writeHead(403, { connection: "close" }).end();
    log({ type: "egress_refused", source: request.socket.remoteAddress ?? null, reason: "not_connect" });
  });
  server.on("connect", (request, client: Socket, head: Buffer) => {
    const source = (client.remoteAddress ?? "").replace(/^::ffff:/, "");
    const refuse = (reason: string, target?: string) => {
      log({ type: "egress_refused", source, target: target ?? null, reason });
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    void (async () => {
      const match = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(request.url ?? "");
      if (!match) return refuse("bad_target");
      const [, host, port] = match as unknown as [string, string, string];
      const target = `${host.toLowerCase()}:${port}`;
      if (port !== "443") return refuse("port", target);
      if (isIP(source) !== 4) return refuse("source", target);
      const policy = await readFile(join(options.policyDir, `${source}.json`), "utf8").then(text => JSON.parse(text) as EgressPolicy).catch(() => undefined);
      if (!policy) return refuse("no_policy", target);
      if (!allowed(host, policy.allow)) return refuse("not_allowed", target);
      const count = open.get(source) ?? 0;
      if (count >= (options.perJob ?? 256)) return refuse("too_many", target);
      if (opened >= (options.total ?? 4096)) return refuse("host_busy", target);
      const addresses = await lookup(host.toLowerCase()).catch(() => [] as string[]);
      if (!addresses.length) return refuse("unresolved", target);
      // Every address public, or none is used: a name that also points inward is refused whole.
      if (!addresses.every(publicAddress)) return refuse("private_address", target);
      open.set(source, count + 1); opened++;
      const upstream = dial(addresses[0]!, 443);
      let released = false;
      const release = () => { if (released) return; released = true; opened--; const left = (open.get(source) ?? 1) - 1; if (left > 0) open.set(source, left); else open.delete(source); };
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
        log({ type: "egress_open", source, job: policy.job, target });
      });
      for (const socket of [upstream, client]) {
        socket.once("error", () => { upstream.destroy(); client.destroy(); });
        socket.once("close", () => { release(); upstream.destroy(); client.destroy(); });
      }
    })().catch(() => refuse("error"));
  });
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
  egressProxy({ policyDir: arg("policies") ?? "/run/camel/egress" }).listen(PROXY_PORT, arg("listen") ?? "0.0.0.0");
}
