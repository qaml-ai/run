import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GUEST_HASHES, hashCost, replay } from "./exchange-replay.ts";

const guest = (hash: keyof typeof GUEST_HASHES) => new Function(`${GUEST_HASHES[hash]}\nreturn keyHash;`)() as (text: string) => string;

test("the guest key hashes are FNV-1a and SHA-256", () => {
  const fnv64 = (text: string) => {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) for (const byte of [text.charCodeAt(i) & 0xff, text.charCodeAt(i) >>> 8]) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return h.toString(16).padStart(16, "0");
  };
  for (const text of ["", "a", "agent:{\"files\":[\"src/a.ts\"]}", "héllo €𝄞"]) {
    assert.equal(guest("fnv1a64")(text), fnv64(text));
    assert.equal(guest("sha256")(text), createHash("sha256").update(text).digest("hex"));
  }
  assert.equal(guest("fnv1a32")("a"), "e40c292c");
});

test("the guest computes the same keys in QuickJS", { timeout: 30_000 }, async () => {
  for (const hash of ["fnv1a64", "sha256"] as const) {
    const cost = await hashCost(hash, 3);
    const args = { type: "reviewer", model: "fast", prompt: "Review src/delegation-2.ts for the owner model refactor.", files: ["src/delegation-2.ts"] };
    const canonical = `{"files":${JSON.stringify(args.files)},"model":"fast","prompt":${JSON.stringify(args.prompt)},"type":"reviewer"}`;
    assert.equal(cost.last, guest(hash)(canonical));
  }
});

test("a step replaying 300 keyed effects through a handle exchange fits the sandbox", { timeout: 60_000 }, async () => {
  for (const mode of ["calls", "table"] as const) {
    const [first, last] = await replay({ effects: 300, mode, results: "handle", hash: "fnv1a64", steps: [1, 300] });
    assert.equal(first!.error, undefined);
    assert.equal(last!.error, undefined, `${mode}: ${last!.error}`);
    // Past code mode's 256 calls: the workflow's exchange has its own caps.
    assert.equal(last!.calls, mode === "calls" ? 300 : 1);
    // Bodies of 20 KB stay on the host; the guest gets handles of about 120 bytes.
    assert.ok(last!.crossedBytes < 300 * 200, `${last!.crossedBytes}`);
    assert.ok(last!.polls < 500, `${mode}: ${last!.polls} polls`);
    assert.ok(last!.heapBytes < 2 * 1024 * 1024, `${mode}: ${last!.heapBytes} bytes of heap`);
  }
});

test("inline, the same journal stops at the 8 MiB the guest may receive", { timeout: 60_000 }, async () => {
  const [last] = await replay({ effects: 500, mode: "calls", results: "inline", hash: "fnv1a64", steps: [500] });
  assert.match(last!.error ?? "", /more than 8,388,608 bytes in all/);
  assert.equal(last!.calls, 419);
});
