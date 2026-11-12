// A job VM's network on a real host (docs/design/job-hosts-plan.md, slice 6). Each job slot has its own tap and /30:
// the host end is 10.200.<slot>.1, the guest's 10.200.<slot>.2. Nothing is forwarded or routed for a tap. A guest's
// only way out is the host's egress proxy (egress-proxy.ts) on its own tap address, which lets a job with internet
// reach only its allowlisted hosts on 443. So a guest has no route to IMDS, the VPC, the host's other services or
// another job's tap. The rules are nftables: a base table the image installs (infra/job-hosts/image/files/
// camel-host.nft), which `baseRules` mirrors so tests can check it, and nothing per job but the tap itself.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** The egress proxy's port on each tap's host address. */
export const PROXY_PORT = 3128;
/** The proxy's user: its own traffic is the only host traffic that leaves for a job, and it is kept off private ranges. */
export const PROXY_USER = "camel-proxy";
/** Its fixed uid (host-setup.sh creates the user with it), so the rules name it without the user existing yet. */
export const PROXY_UID = 940;
/** Job slots one host can address (10.200.0.0/16, one /30 per slot in its own /24). */
export const MAX_SLOTS = 250;

export type JobAddress = { slot: number; tap: string; hostIp: string; guestIp: string; mac: string; prefix: 30 };

/** A slot's tap, addresses and MAC. */
export function jobAddress(slot: number): JobAddress {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) throw new Error(`Invalid job slot ${slot}`);
  const hex = slot.toString(16).padStart(2, "0");
  return { slot, tap: `cj${slot}`, hostIp: `10.200.${slot}.1`, guestIp: `10.200.${slot}.2`, mac: `06:00:0a:c8:${hex}:02`, prefix: 30 };
}

/** The guest's kernel arguments for its network (read by the guest's init, infra/job-hosts/image/files/camel-init). */
export function guestNetArgs(address: JobAddress, internet: boolean) {
  return [`camel.ip=${address.guestIp}/${address.prefix}`, `camel.gw=${address.hostIp}`, ...(internet ? [`camel.proxy=http://${address.hostIp}:${PROXY_PORT}`] : [])].join(" ");
}

/**
 * The host's base rules, as the image installs them (camel-host.nft holds the same text; a test checks they match).
 * - From a job tap, the host accepts only the egress proxy's port on that tap's own address, from that tap's own
 *   guest (a source address that does not route back through the tap it came in on is dropped, so a guest cannot pass
 *   for another job's). Nothing else on the host answers a guest; the proxy's port answers nothing but the taps.
 * - Nothing is forwarded to or from a job tap, so a guest reaches no other network, IMDS, or another job.
 * - The host opens no connection into a guest (the agent talks to it over vsock).
 * - The proxy's own connections go to public addresses on 443, plus DNS to Amazon's resolver: never to IMDS, the VPC
 *   or loopback, even if a name resolves there.
 */
export function baseRules() {
  return `# camelRun job host base rules (generated from jobhost/network.ts baseRules; a test checks this file matches).
table inet camel_jobs
delete table inet camel_jobs
table inet camel_jobs {
  set private4 {
    type ipv4_addr; flags interval
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 }
  }
  set private6 {
    type ipv6_addr; flags interval
    elements = { ::/127, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 }
  }
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "cj*" jump from_job
    tcp dport ${PROXY_PORT} counter drop
  }
  chain from_job {
    fib saddr . iif oif missing counter drop
    ct state established,related accept
    fib daddr . iif type local tcp dport ${PROXY_PORT} ct state new accept
    counter drop
  }
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "cj*" counter drop
    oifname "cj*" counter drop
  }
  chain output {
    type filter hook output priority filter; policy accept;
    oifname "cj*" ct state established,related accept
    oifname "cj*" counter drop
    meta skuid ${PROXY_UID} jump proxy_out
  }
  chain proxy_out {
    oifname "lo" counter drop
    ip daddr 169.254.169.253 meta l4proto { tcp, udp } th dport 53 accept
    ip daddr @private4 counter drop
    ip6 daddr fd00:ec2::253 meta l4proto { tcp, udp } th dport 53 accept
    ip6 daddr @private6 counter drop
    tcp dport 443 accept
    counter drop
  }
}
`;
}

type Exec = (file: string, args: string[]) => Promise<unknown>;
const run: Exec = (file, args) => promisify(execFile)(file, args);

/** A job's tap: made (with the host end's address) before its VM boots, removed after it ends. */
export function tapCommands(address: JobAddress) {
  return {
    up: [
      ["ip", "tuntap", "add", "dev", address.tap, "mode", "tap"],
      ["ip", "addr", "add", `${address.hostIp}/${address.prefix}`, "dev", address.tap],
      ["ip", "link", "set", "dev", address.tap, "up"],
    ],
    down: [["ip", "link", "del", "dev", address.tap]],
  };
}

export async function tapUp(address: JobAddress, exec: Exec = run) {
  // A tap left by a host agent that died is replaced.
  await exec("ip", ["link", "del", "dev", address.tap]).catch(() => {});
  for (const [file, ...args] of tapCommands(address).up) await exec(file!, args);
}
export async function tapDown(address: JobAddress, exec: Exec = run) {
  for (const [file, ...args] of tapCommands(address).down) await exec(file!, args).catch(() => {});
}
