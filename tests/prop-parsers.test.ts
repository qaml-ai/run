import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import * as schemas from "../src/api-schemas.ts";
import { answerList, spendInput } from "../src/client-sessions.ts";
import { HttpError } from "../src/http.ts";
import { addressBytes, Outbound, OutboundBlocked } from "../src/outbound.ts";
import { frames } from "../src/sandbox-wire.ts";
import { Tenants } from "../src/tenants.ts";
import { check, fc } from "./prop-helpers.ts";

/**
 * I18 (design §3): malformed input gives a clean error (a 4xx, a destroyed socket), never an exception that escapes as
 * a 500, a hang, or unbounded allocation; and the outbound address policy (SSRF guard) against a model of what is
 * reachable.
 */

// --- Length-prefixed frames (sandbox-wire.ts) ------------------------------------------------------------------------

/** A socket as `frames` sees it: data in, writes out, and destroy. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  error?: Error;
  written: Buffer[] = [];
  destroy(error?: Error) { this.destroyed = true; this.error = error; return this; }
  cork() {}
  uncork() {}
  write(chunk: Buffer) { this.written.push(Buffer.from(chunk)); return true; }
  feed(chunk: Buffer) { if (!this.destroyed) this.emit("data", chunk); }
}
/** `bytes` cut at the given points (any chunking a stream may deliver). */
function chunked(bytes: Buffer, cuts: number[]) {
  const points = [...new Set(cuts.map(cut => cut % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let from = 0;
  for (const point of [...points, bytes.length]) { if (point > from) chunks.push(bytes.subarray(from, point)); from = Math.max(from, point); }
  return chunks;
}
const normal = (value: unknown) => JSON.parse(JSON.stringify(value));

test("frames: any sequence of messages, cut into chunks anywhere, arrives whole, in order, once", async t => {
  await check(t, fc.property(fc.array(fc.jsonValue({ maxDepth: 3 }), { maxLength: 12 }), fc.array(fc.nat(), { maxLength: 30 }), (messages, cuts) => {
    const out = new FakeSocket();
    const send = frames(out as unknown as Socket, () => {});
    for (const message of messages) send(message);
    const received: unknown[] = [];
    const into = new FakeSocket();
    frames(into as unknown as Socket, message => received.push(message));
    for (const chunk of chunked(Buffer.concat(out.written), cuts)) into.feed(chunk);
    assert.equal(into.destroyed, false);
    assert.deepEqual(received, messages.map(normal));
  }), { runs: 300 });
});

test("frames: arbitrary bytes give whole JSON messages or a destroyed socket, never a throw, and never buffer past the limit", async t => {
  const garbage = fc.oneof(
    fc.uint8Array({ maxLength: 64 }).map(bytes => Buffer.from(bytes)),
    // A plausible header (sometimes huge, sometimes past the limit) and whatever follows.
    fc.tuple(fc.oneof(fc.nat({ max: 80 }), fc.constantFrom(256, 4096, 0xffffffff)), fc.uint8Array({ maxLength: 48 })).map(([length, rest]) => { const header = Buffer.alloc(4); header.writeUInt32BE(length); return Buffer.concat([header, Buffer.from(rest)]); }),
    fc.jsonValue({ maxDepth: 2 }).map(value => { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); }),
  );
  await check(t, fc.property(fc.array(garbage, { maxLength: 10 }), fc.array(fc.nat(), { maxLength: 20 }), fc.integer({ min: 8, max: 300 }), (pieces, cuts, max) => {
    const into = new FakeSocket();
    const received: unknown[] = [];
    let afterDestroy = 0;
    frames(into as unknown as Socket, message => { if (into.destroyed) afterDestroy++; received.push(message); }, max);
    const stream = Buffer.concat(pieces);
    let fed = 0;
    for (const chunk of chunked(stream, cuts)) {
      into.feed(chunk);
      if (!into.destroyed) fed += chunk.length;
    }
    assert.equal(afterDestroy, 0, "no message after the socket is destroyed");
    if (into.destroyed) assert.match(into.error!.message, /^Sandbox frame (exceeds size limit|is not JSON)$/);
    // Decoding the stream independently: the messages are exactly the whole, valid frames before the first bad one.
    const expected: unknown[] = [];
    let offset = 0, bad = false;
    while (offset + 4 <= stream.length) {
      const length = stream.readUInt32BE(offset);
      if (length > max) { bad = true; break; }
      if (offset + 4 + length > stream.length) break;
      try { expected.push(JSON.parse(stream.subarray(offset + 4, offset + 4 + length).toString("utf8"))); }
      catch { bad = true; break; }
      offset += 4 + length;
    }
    assert.deepEqual(received, expected);
    assert.equal(into.destroyed, bad);
    // Bounded: what a live socket holds is less than one frame of the limit beyond what it delivered.
    if (!into.destroyed) assert.ok(fed - offset <= max + 4 + stream.length, "held bytes stay bounded");
  }), { runs: 400 });
});

test("frames: a message past the limit is refused before anything is written", async t => {
  await check(t, fc.property(fc.string({ minLength: 1, maxLength: 200 }), fc.integer({ min: 2, max: 100 }), (text, max) => {
    const out = new FakeSocket();
    const send = frames(out as unknown as Socket, () => {}, max);
    const body = Buffer.byteLength(JSON.stringify(text));
    if (body > max) { assert.throws(() => send(text), /exceeds size limit/); assert.equal(out.written.length, 0); }
    else { send(text); assert.equal(Buffer.concat(out.written).length, 4 + body); }
  }), { runs: 200 });
});

// --- Request bodies --------------------------------------------------------------------------------------------------

/** JSON a client may send, with keys that trip careless code: prototype names, numbers as keys, empty strings. */
const hostileJson = fc.letrec(tie => ({
  value: fc.oneof({ depthSize: "small" }, fc.constant(null), fc.boolean(), fc.double(), fc.integer(), fc.string({ maxLength: 6 }), fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.oneof(fc.string({ maxLength: 4 }), fc.constantFrom("__proto__", "constructor", "toString", "id", "answers", "usd", "action")), tie("value"), { maxKeys: 4 })),
})).value.map(value => JSON.parse(JSON.stringify(value) ?? "null") as unknown); // As a request body parses: own keys only, even "__proto__".

/** Run `parse` on `input`: a value, or an HttpError 400 for a person to read; any other throw is the bug this looks for. */
function cleanly(parse: () => unknown) {
  try { return { value: parse() }; }
  catch (error) {
    assert.ok(error instanceof HttpError, `threw ${String(error)}, which would answer 500`);
    assert.equal(error.status, 400);
    return { status: 400 };
  }
}

test("answers to inputs: any body is a list of answers or a 400, never a TypeError", async t => {
  const answer = fc.oneof(hostileJson, fc.record({ id: fc.oneof(hostileJson, fc.constantFrom({ toString: null }, { valueOf: null, toString: null })), action: hostileJson }, { requiredKeys: [] }));
  const body = fc.oneof(hostileJson, fc.record({ answers: fc.array(answer, { maxLength: 4 }) }).map(value => JSON.parse(JSON.stringify(value))));
  await check(t, fc.property(body, input => {
    const got = cleanly(() => answerList(input));
    if ("value" in got) for (const answer of got.value as { id: string; body: unknown }[]) assert.equal(typeof answer.id, "string");
  }), { runs: 400 });
});

test("spend limits: any value is {usd} in range, null, or a 400", async t => {
  await check(t, fc.property(fc.oneof(hostileJson, fc.record({ usd: fc.oneof(fc.double(), fc.string()) })), input => {
    const got = cleanly(() => spendInput(input));
    if ("value" in got && got.value !== null) assert.ok(typeof got.value === "number" && got.value >= 0 && got.value <= 1_000_000);
  }), { runs: 400 });
});

test("API input schemas: any JSON is accepted or refused with an issue, never a throw", async t => {
  const inputs = Object.entries(schemas).filter(([name, value]) => /(Input|Inputs|Update)$/.test(name) && typeof (value as { safeParse?: unknown }).safeParse === "function") as [string, { safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } } }][];
  assert.ok(inputs.length > 20, `found ${inputs.length} input schemas`);
  await check(t, fc.property(fc.constantFrom(...inputs), hostileJson, ([name, schema], input) => {
    const result = schema.safeParse(input);
    if (!result.success) assert.equal(typeof result.error!.issues[0]?.message, "string", `${name} refused without an issue`);
  }), { runs: 600 });
});

// --- The tenants file ------------------------------------------------------------------------------------------------

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** Near-valid tenants files: real fields with values right, wrong, or of the wrong type. */
/** A value that is right most of the time, else wrong in one of the ways given. */
const mostly = (right: fc.Arbitrary<unknown>, ...wrong: fc.Arbitrary<unknown>[]): fc.Arbitrary<unknown> => fc.oneof({ weight: 6, arbitrary: right }, ...wrong.map(arbitrary => ({ weight: 1, arbitrary })));
const tenantEntry = fc.record({
  // "own": the tenant's own token hash (each tenant needs a distinct one), filled in below.
  tokenSha256: mostly(fc.constant("own"), fc.constantFrom(sha("shared")), fc.string({ maxLength: 4 }), fc.constant(null)),
  apiKeys: mostly(fc.dictionary(fc.constantFrom("anthropic", "openai"), fc.string({ minLength: 1, maxLength: 4 })), fc.dictionary(fc.constantFrom("*", "constructor", "anthropic"), fc.oneof(fc.string({ maxLength: 4 }), fc.integer())), fc.constant(null), fc.array(fc.string())),
  billing: mostly(fc.constantFrom("prepaid", "none"), fc.constantFrom("free", 3)),
  maxAgents: mostly(fc.integer({ min: 1, max: 9 }), fc.integer({ min: -1, max: 0 }), fc.double(), fc.string()),
  platformKeys: mostly(fc.constant(false), fc.boolean(), fc.string()),
  modelEndpoints: mostly(fc.dictionary(fc.constantFrom("mine", "gw"), fc.record({ baseUrl: fc.constantFrom("https://gw.example.com", "http://localhost:9") }), { maxKeys: 1 }),
    fc.constant(null), fc.dictionary(fc.constantFrom("mine", "anthropic", "Bad"), fc.oneof(fc.record({ baseUrl: fc.constantFrom("http://evil.example", "nope", "https://u:p@x.example") }), fc.constant(null), fc.integer()))),
  maxMonthlyCost: mostly(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double(), fc.string()),
}, { requiredKeys: [] });
const tenantsFile = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    tenants: fc.dictionary(mostly(fc.constantFrom("acme", "beta", "gamma-2"), fc.constantFrom("Bad Id", "", "__proto__", "constructor"), fc.string({ maxLength: 5 })) as fc.Arbitrary<string>, tenantEntry, { maxKeys: 3 }),
    platformKeys: mostly(fc.dictionary(fc.constantFrom("anthropic", "openrouter"), fc.string({ minLength: 1, maxLength: 4 })), fc.dictionary(fc.constantFrom("*", "constructor"), fc.oneof(fc.string({ maxLength: 4 }), fc.integer())), fc.constant(null), fc.string()),
  }, { requiredKeys: ["tenants"] }).map(file => JSON.stringify({ ...file, tenants: Object.fromEntries(Object.entries(file.tenants).map(([id, entry]) => [id, entry.tokenSha256 === "own" ? { ...entry, tokenSha256: sha(id) } : entry])) })) },
  { weight: 1, arbitrary: fc.json() },
  { weight: 1, arbitrary: fc.string() },
);
/** Provider names a request may ask for: those in files, and ones that name members of every object. */
const providers = ["anthropic", "openai", "mine", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

test("tenants file: any contents load whole or are refused whole, keeping the tenants before; keys are only the ones given", async t => {
  const valid = JSON.stringify({ tenants: { keep: { tokenSha256: sha("keep"), apiKeys: { anthropic: "kept-key" } } } });
  await check(t, fc.asyncProperty(tenantsFile, async text => {
    let contents = valid;
    const tenants = new Tenants({ read: async () => contents });
    await tenants.reload();
    {
      contents = text;
      try { await tenants.reload(); }
      catch (error) {
        assert.ok(error instanceof Error, `refused with ${String(error)}`);
        // Refused whole: the tenants loaded before still answer.
        assert.equal(tenants.has("keep"), true);
        assert.equal(tenants.apiKey("keep", "anthropic"), "kept-key");
        return;
      }
      const parsed = JSON.parse(text) as { tenants: Record<string, { apiKeys?: Record<string, string> }>; platformKeys?: Record<string, string> };
      for (const id of Object.keys(parsed.tenants)) {
        assert.ok(tenants.has(id) && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id));
        for (const provider of providers) {
          const key = tenants.apiKey(id, provider);
          const given = parsed.tenants[id].apiKeys;
          assert.equal(key, given && Object.hasOwn(given, provider) ? given[provider] : undefined, `tenant ${id}'s key for ${provider}`);
        }
      }
      for (const provider of providers) {
        const given = parsed.platformKeys ?? {};
        assert.equal(tenants.platformKey(provider), Object.hasOwn(given, provider) ? given[provider] : undefined, `platform key for ${provider}`);
      }
    }
  }), { runs: 400 });
});

// --- The outbound address policy (SSRF guard) ------------------------------------------------------------------------

/**
 * A model of the policy, on 128-bit integers: the ranges the runtime documents as unreachable (outbound.ts), and IPv6
 * addresses that carry an IPv4 one (mapped, NAT64, 6to4) judged by that address.
 */
const V4_BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
const V6_BLOCKED = ["::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"];
const v4Int = (text: string) => text.split(".").reduce((sum, part) => (sum << 8n) | BigInt(Number(part)), 0n);
/** A model parse of IPv6 text, independent of the runtime's: Node's URL parser normalizes it to eight groups for us. */
function v6Int(text: string) {
  const normalized = new URL(`http://[${text}]`).hostname.slice(1, -1);
  const [head, tail] = normalized.split("::");
  const groups = (part?: string) => part ? part.split(":").map(group => BigInt(parseInt(group, 16))) : [];
  const left = groups(head), right = groups(tail);
  const all = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0n), ...right];
  return all.reduce((sum, group) => (sum << 16n) | group, 0n);
}
type Range = { base: bigint; prefix: number; bits: number };
const range = (text: string, bits: number): Range => { const [address, prefix] = text.split("/"); return { base: bits === 32 ? v4Int(address) : v6Int(address), prefix: Number(prefix), bits }; };
const inRange = (value: bigint, { base, prefix, bits }: Range) => (value >> BigInt(bits - prefix)) === (base >> BigInt(bits - prefix));
const V4 = V4_BLOCKED.map(text => range(text, 32)), V6 = V6_BLOCKED.map(text => range(text, 128));
const MAPPED = range("::ffff:0:0/96", 128), NAT64 = range("64:ff9b::/96", 128), SIX_TO_FOUR = range("2002::/16", 128);
const v4Text = (value: bigint) => [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 0xffn)).join(".");
function modelBlocked(v4?: bigint, v6?: bigint, policy: { allow: Range[]; block: Range[] } = { allow: [], block: [] }): boolean {
  if (v4 !== undefined) {
    if (policy.block.some(r => r.bits === 32 && inRange(v4, r))) return true;
    if (policy.allow.some(r => r.bits === 32 && inRange(v4, r))) return false;
    return V4.some(r => inRange(v4, r));
  }
  const value = v6!;
  if (policy.block.some(r => r.bits === 128 && inRange(value, r))) return true;
  if (policy.allow.some(r => r.bits === 128 && inRange(value, r))) return false;
  if (V6.some(r => inRange(value, r))) return true;
  const inner = inRange(value, MAPPED) || inRange(value, NAT64) ? value & 0xffffffffn : inRange(value, SIX_TO_FOUR) ? (value >> 80n) & 0xffffffffn : undefined;
  return inner === undefined ? false : modelBlocked(inner, undefined, policy);
}
/** Addresses near every boundary that matters: random ones, and ones inside each blocked or embedding range. */
const v4 = fc.oneof(fc.bigInt({ min: 0n, max: 0xffffffffn }), fc.tuple(fc.constantFrom(...V4), fc.bigInt({ min: 0n, max: 0xffffffffn })).map(([r, noise]) => (r.base & ~((1n << BigInt(32 - r.prefix)) - 1n)) | (noise & ((1n << BigInt(32 - r.prefix)) - 1n))));
const v6 = fc.oneof(
  fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }),
  fc.tuple(fc.constantFrom(...V6, MAPPED, NAT64, SIX_TO_FOUR, range("2002::/16", 128)), fc.bigInt({ min: 0n, max: (1n << 128n) - 1n })).map(([r, noise]) => (r.base & ~((1n << BigInt(128 - r.prefix)) - 1n)) | (noise & ((1n << BigInt(128 - r.prefix)) - 1n))),
  fc.tuple(fc.constantFrom(MAPPED, NAT64), v4).map(([r, inner]) => r.base | inner),
  v4.map(inner => SIX_TO_FOUR.base | (inner << 80n)),
);
/** An address to judge: IPv4 or IPv6, as a number. */
type Address = { v4?: bigint; v6?: bigint };
const address: fc.Arbitrary<Address> = fc.oneof(v4.map(value => ({ v4: value })), v6.map(value => ({ v6: value })));
/** Ways to write one IPv6 address: full, zero-padded, compressed, upper case, with an IPv4 tail, with a zone. */
function spellings(value: bigint) {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(112 - 16 * index)) & 0xffffn));
  const full = groups.map(group => group.toString(16)).join(":");
  const tail = `${groups.slice(0, 6).map(group => group.toString(16)).join(":")}:${v4Text(value & 0xffffffffn)}`;
  return [full, groups.map(group => group.toString(16).padStart(4, "0")).join(":"), new URL(`http://[${full}]`).hostname.slice(1, -1), full.toUpperCase(), tail, `${full}%eth0`];
}
const bytesOf = (value: bigint, length: number) => Uint8Array.from({ length }, (_, index) => Number((value >> BigInt(8 * (length - 1 - index))) & 0xffn));

test("SSRF guard: every spelling of an address parses to its bytes and is blocked exactly when the model says", async t => {
  const outbound = new Outbound();
  await check(t, fc.property(address, ({ v4: four, v6: six }) => {
    if (four !== undefined) {
      const text = v4Text(four);
      assert.deepEqual(addressBytes(text), bytesOf(four, 4));
      assert.equal(!!outbound.blocked(text), modelBlocked(four), `${text}`);
      // URLs: the parser turns other IPv4 spellings into dotted form, which the check sees.
      for (const host of [text, String(four), `0x${four.toString(16)}`]) {
        let blocked = false;
        try { outbound.check(`https://${host}/`); } catch (error) { assert.ok(error instanceof OutboundBlocked); blocked = true; }
        assert.equal(blocked, modelBlocked(four), `https://${host}/`);
      }
      return;
    }
    for (const text of spellings(six!)) {
      assert.deepEqual(addressBytes(text), bytesOf(six!, 16), text);
      assert.equal(!!outbound.blocked(text), modelBlocked(undefined, six), text);
    }
    let blocked = false;
    try { outbound.check(`https://[${spellings(six!)[0]}]/`); } catch (error) { assert.ok(error instanceof OutboundBlocked); blocked = true; }
    assert.equal(blocked, modelBlocked(undefined, six));
  }), { runs: 600 });
});

test("SSRF guard: an operator's block always wins, its allow opens only the built-in blocks, at any prefix", async t => {
  const cidr4 = fc.tuple(v4, fc.integer({ min: 0, max: 32 })).map(([value, prefix]) => `${v4Text(value)}/${prefix}`);
  const cidr6 = fc.tuple(v6, fc.integer({ min: 0, max: 128 })).map(([value, prefix]) => `${spellings(value)[2]}/${prefix}`);
  await check(t, fc.property(fc.array(fc.oneof(cidr4, cidr6), { maxLength: 3 }), fc.array(fc.oneof(cidr4, cidr6), { maxLength: 3 }), address, (allow, block, address) => {
    const outbound = new Outbound({ allow, block });
    const policy = { allow: allow.map(text => range(text, text.includes(":") ? 128 : 32)), block: block.map(text => range(text, text.includes(":") ? 128 : 32)) };
    const text = address.v4 !== undefined ? v4Text(address.v4) : spellings(address.v6!)[2];
    assert.equal(!!outbound.blocked(text), modelBlocked(address.v4, address.v6, policy), `${text} with allow ${allow} block ${block}`);
  }), { runs: 400 });
});

test("SSRF guard: the cloud metadata endpoints and loopback are unreachable in every encoding", () => {
  const outbound = new Outbound();
  for (const text of ["169.254.169.254", "169.254.170.2", "127.0.0.1", "0.0.0.0", "::1", "::", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe",
    "64:ff9b::127.0.0.1", "2002:a9fe:a9fe::", "2002:7f00:1::1", "::169.254.169.254", "0:0:0:0:0:ffff:7f00:1", "fe80::1%eth0", "::ffff:10.0.0.1", "64:ff9b:1::a9fe:a9fe"]) {
    assert.ok(outbound.blocked(text), `${text} is reachable`);
  }
  for (const url of ["https://2852039166/", "https://0xa9fea9fe/", "https://0251.0376.0251.0376/", "https://169.254.43518/", "https://[::ffff:169.254.169.254]/", "https://127.1/", "https://[::]/"]) {
    assert.throws(() => outbound.check(url), OutboundBlocked, url);
  }
});
