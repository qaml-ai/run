// Generated from src/outbound.ts; only host imports are replaced.
// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.
import { isIP } from "node:net";
type Cidr = { bytes: Uint8Array; prefix: number };
const BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
// Unspecified, loopback and IPv4-compatible (::/96), local-use NAT64, discard, Teredo, documentation,
// unique local (fc00::/7, including the instance endpoint fd00:ec2::254), link-local, site-local, multicast.
const BLOCKED_V6 = ["::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"];

/** An address as bytes: 4 for IPv4, 16 for IPv6; undefined when it is neither. */
export function addressBytes(address: string): Uint8Array | undefined {
  const version = isIP(address);
  if (version === 4) return Uint8Array.from(address.split(".").map(Number));
  if (version !== 6) return undefined;
  let text = address.toLowerCase().split("%")[0];
  let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = dotted[2].split(".").map(Number);
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = text.split("::");
  const groups = (part: string | undefined) => part ? part.split(":").map(group => parseInt(group, 16)) : [];
  const left = groups(halves[0]), right = groups(halves[1]);
  const zeros = halves.length > 1 ? 8 - tail.length - left.length - right.length : 0;
  const all = [...left, ...Array(Math.max(0, zeros)).fill(0), ...right, ...tail];
  if (all.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  all.forEach((group, index) => { bytes[index * 2] = group >> 8; bytes[index * 2 + 1] = group & 0xff; });
  return bytes;
}

function cidr(text: string): Cidr {
  const [address, bits] = text.trim().split("/");
  const bytes = addressBytes(address);
  const prefix = bits === undefined ? (bytes?.length ?? 0) * 8 : Number(bits);
  if (!bytes || !Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) throw new Error(`Invalid CIDR ${text}`);
  return { bytes, prefix };
}

function within(bytes: Uint8Array, range: Cidr) {
  if (bytes.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.prefix; bit += 8) {
    const mask = range.prefix - bit >= 8 ? 0xff : (0xff << (8 - (range.prefix - bit))) & 0xff;
    if ((bytes[bit / 8] & mask) !== (range.bytes[bit / 8] & mask)) return false;
  }
  return true;
}

const BUILT_IN = [...BLOCKED_V4, ...BLOCKED_V6].map(cidr);
const MAPPED = cidr("::ffff:0:0/96"), NAT64 = cidr("64:ff9b::/96"), SIX_TO_FOUR = cidr("2002::/16");

/** The IPv4 address an IPv6 address carries (mapped, NAT64 or 6to4), which is what it reaches. */
function embedded(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length !== 16) return undefined;
  if (within(bytes, MAPPED) || within(bytes, NAT64)) return bytes.slice(12);
  if (within(bytes, SIX_TO_FOUR)) return bytes.slice(2, 6);
  return undefined;
}


export { BUILT_IN, cidr, within, embedded };