import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { verifyDkim } from "../src/core/channels/dkim.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const pkcs1 = pair.publicKey.export({ type: "pkcs1", format: "der" }).toString("base64");
const ed = generateKeyPairSync("ed25519");
const edRaw = ed.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const dns: Record<string, string[]> = {
  "s1._domainkey.example.com": [`v=DKIM1; k=rsa; p=${spki}`],
  "old._domainkey.example.com": [`v=DKIM1; p=${pkcs1}`],
  "ed._domainkey.example.com": [`v=DKIM1; k=ed25519; p=${edRaw}`],
  "gone._domainkey.example.com": ["v=DKIM1; p="],
};
const lookup = async (name: string) => dns[name] ?? [];

const MESSAGE = "From: Ada <ada@example.com>\r\nTo:  support@in.example.test\r\nSubject: Hello   there\r\nMessage-ID: <m1@example.com>\r\n\r\nHi,  team \r\n\r\n\r\n";

function signed(raw: string, options: { canon?: "relaxed" | "simple"; selector?: string; algorithm?: string; key?: KeyObject; extra?: string; headers?: string[] } = {}) {
  const canon = options.canon ?? "relaxed";
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split + 2), body = raw.slice(split + 4);
  const relax = (line: string) => `${line.slice(0, line.indexOf(":")).trim().toLowerCase()}:${line.slice(line.indexOf(":") + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim()}`;
  const canonBody = canon === "relaxed"
    ? (text => text ? `${text}\r\n` : "")(body.split("\r\n").map(line => line.replace(/[ \t]+/g, " ").replace(/ $/, "")).join("\r\n").replace(/(\r\n)*$/, ""))
    : `${body.replace(/(\r\n)*$/, "")}\r\n`;
  const bh = createHash("sha256").update(canonBody).digest("base64");
  const lines = head.split(/\r\n(?=[^ \t])/).filter(Boolean).map(line => line.replace(/\r\n$/, ""));
  const names = options.headers ?? ["from", "to", "subject", "message-id"];
  const algorithm = options.algorithm ?? "rsa-sha256";
  const unsigned = `DKIM-Signature: v=1; a=${algorithm}; c=${canon}/${canon}; d=example.com; s=${options.selector ?? "s1"};${options.extra ?? ""} h=${names.join(":")}; bh=${bh}; b=`;
  const pick = (name: string) => lines.filter(line => line.toLowerCase().startsWith(`${name}:`)).at(-1)!;
  const data = [...names.map(name => `${canon === "relaxed" ? relax(pick(name)) : pick(name)}\r\n`), canon === "relaxed" ? relax(unsigned) : unsigned].join("");
  const b = algorithm === "ed25519-sha256"
    ? sign(null, createHash("sha256").update(data).digest(), options.key ?? ed.privateKey).toString("base64")
    : sign("sha256", Buffer.from(data), options.key ?? pair.privateKey).toString("base64");
  return `${unsigned}${b}\r\n${raw}`;
}
const bytes = (text: string) => new TextEncoder().encode(text);

test("DKIM: relaxed and simple signatures verify against the published key; any change to what is signed fails", async () => {
  assert.deepEqual((await verifyDkim(bytes(signed(MESSAGE)), lookup)).passed, ["example.com"]);
  assert.deepEqual((await verifyDkim(bytes(signed(MESSAGE, { canon: "simple" })), lookup)).passed, ["example.com"]);
  assert.deepEqual((await verifyDkim(bytes(signed(MESSAGE, { selector: "old" })), lookup)).passed, ["example.com"], "a PKCS#1 key in DNS");
  assert.deepEqual((await verifyDkim(bytes(signed(MESSAGE, { selector: "ed", algorithm: "ed25519-sha256" })), lookup)).passed, ["example.com"], "Ed25519");
  // Relaxed canonicalization forgives whitespace a relay may change.
  assert.deepEqual((await verifyDkim(bytes(signed(MESSAGE).replace("Subject: Hello   there", "Subject:  Hello there")), lookup)).passed, ["example.com"]);

  const failed = async (raw: string) => (await verifyDkim(bytes(raw), lookup)).failed;
  assert.deepEqual(await failed(signed(MESSAGE).replace("Hi,  team", "Hi, eve")), ["body_hash"]);
  assert.deepEqual(await failed(signed(MESSAGE).replace("ada@example.com", "eve@example.com")), ["signature"]);
  assert.deepEqual(await failed(signed(MESSAGE, { key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey })), ["signature"]);
  assert.deepEqual(await failed(signed(MESSAGE, { selector: "nope" })), ["no_key"]);
  assert.deepEqual(await failed(signed(MESSAGE, { selector: "gone" })), ["key_revoked"]);
  assert.deepEqual(await failed(signed(MESSAGE, { headers: ["to", "subject"] })), ["from_unsigned"]);
  assert.deepEqual(await failed(signed(MESSAGE, { extra: " l=2;" })), ["partial_body"], "a partial body lets anything follow");
  assert.deepEqual(await failed(signed(MESSAGE, { extra: ` x=${Math.floor(Date.now() / 1000) - 60};` })), ["expired"]);
  assert.deepEqual(await failed(signed(MESSAGE, { algorithm: "rsa-sha1" })), ["algorithm"]);
  assert.deepEqual(await failed(MESSAGE), []);
  // A From added above the signed one would be what people read, and no signature covers it.
  assert.deepEqual(await failed(`From: Eve <eve@example.com>\r\n${signed(MESSAGE)}`.replace(/^(From: Eve[^\r]*\r\n)(DKIM-Signature[^\r]*\r\n)/, "$2$1")), ["from_count"]);
  const lookups: string[] = [];
  await verifyDkim(bytes(signed(MESSAGE)), async name => { lookups.push(name); throw new Error("down"); });
  assert.deepEqual(lookups, ["s1._domainkey.example.com"]);
  assert.deepEqual((await verifyDkim(bytes(signed(MESSAGE)), async () => { throw new Error("down"); })).failed, ["dns_failed"]);
});
