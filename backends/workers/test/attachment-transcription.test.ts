import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  transcribeAttachments,
  type AttachmentAudioScope,
} from "../src/attachment-transcription.ts";
import { Transcriber } from "../src/media/transcription.ts";
import type { AttachedFile } from "../src/attachment-markers.ts";

const audio = readFileSync(
  new URL("../../../tests/fixtures/audio/hello.ogg", import.meta.url),
);
const file: AttachedFile = {
  type: "file",
  path: "/workspace/voice.ogg",
  volume: "volume",
  key: "files/tenant/volume/audio",
  chunks: ["a".repeat(64)],
  version: 1,
  size: audio.length,
  contentType: "audio/ogg",
};
const scope: AttachmentAudioScope = {
  tenant: "tenant",
  agent: "agent",
  requestId: "request",
};
function setup(key = true) {
  let calls = 0;
  const rows = new Map<string, unknown>(),
    records: unknown[] = [];
  const storage = {
    async get(name: string) {
      return rows.get(name);
    },
    async put(name: string, value: unknown) {
      rows.set(name, structuredClone(value));
    },
    async delete(name: string) {
      rows.delete(name);
    },
    async list({ prefix }: { prefix: string }) {
      return new Map([...rows].filter(([name]) => name.startsWith(prefix)));
    },
    async transaction(run: (tx: unknown) => unknown) {
      return run(storage);
    },
  } as unknown as DurableObjectStorage;
  const transcriber = new Transcriber({
    provider: {
      id: "openai",
      model: "fixture",
      async transcribe() {
        calls++;
        return {
          text: "A transcript",
          language: "en",
          seconds: 5,
          model: "fixture",
        };
      },
    },
    key: async () =>
      key ? { apiKey: "synthetic-key", platform: true } : undefined,
    price: () => 600_000,
  });
  const host = {
    transcriber,
    read: async () => audio,
    budget: async () => 1,
    admit: async () => {},
    record: async (receipt: unknown) => {
      records.push(receipt);
    },
  };
  return { storage, rows, records, host, calls: () => calls };
}

test("attachment transcription is cached with its usage and retries never repeat a known provider call", async () => {
  const h = setup();
  const first = await transcribeAttachments(
    {} as never,
    h.storage,
    scope,
    [file],
    h.host,
  );
  assert.deepEqual(first[0].transcript, {
    text: "A transcript",
    language: "en",
    seconds: 5,
    model: "fixture",
  });
  assert.deepEqual(
    await transcribeAttachments({} as never, h.storage, scope, [file], h.host),
    first,
  );
  assert.equal(h.calls(), 1);
  assert.equal(h.records.length, 1);
  assert.equal((h.records[0] as any).usage.usage.cost.total, 0.05);
});

test("missing keys leave default audio with a reason and refuse explicitly requested transcription", async () => {
  const h = setup(false);
  const plain = await transcribeAttachments(
    {} as never,
    h.storage,
    scope,
    [file],
    h.host,
  );
  assert.match(plain[0].untranscribed!, /Transcription needs an OpenAI key/);
  await assert.rejects(
    transcribeAttachments(
      {} as never,
      h.storage,
      { ...scope, requestId: "explicit" },
      [{ ...file, transcribe: true }],
      h.host,
    ),
    (error: any) =>
      error.status === 400 && error.code === "TRANSCRIPTION_UNAVAILABLE",
  );
  assert.equal(h.calls(), 0);
  const kept = await transcribeAttachments(
    {} as never,
    h.storage,
    scope,
    [{ ...file, transcribe: false }],
    h.host,
  );
  assert.equal(kept[0].untranscribed, undefined);
});

test("an insufficient combined audio budget refuses before a provider call", async () => {
  const h = setup();
  await assert.rejects(
    transcribeAttachments({} as never, h.storage, scope, [file], {
      ...h.host,
      budget: async () => 0.01,
    }),
    (error: any) => error.status === 402 && error.code === "SPEND_LIMIT",
  );
  assert.equal(h.calls(), 0);
});

test("a known transcript survives failed billing and resumes settlement without retranscription", async () => {
  const h = setup();
  await assert.rejects(
    transcribeAttachments({} as never, h.storage, scope, [file], {
      ...h.host,
      record: async () => {
        throw new Error("database unavailable");
      },
    }),
    /database unavailable/,
  );
  assert.equal(h.calls(), 1);
  assert.equal(
    [...h.rows.keys()].filter((key) => key.startsWith("transcription-billing:"))
      .length,
    1,
  );
  const retried = await transcribeAttachments(
    {} as never,
    h.storage,
    scope,
    [file],
    h.host,
  );
  assert.equal(retried[0].transcript?.text, "A transcript");
  assert.equal(h.calls(), 1);
  assert.equal(h.records.length, 1);
  assert.equal(
    [...h.rows.keys()].filter((key) => key.startsWith("transcription-billing:"))
      .length,
    0,
  );
});

test("end-user settlement replays its durable debit before a cached transcript returns", async () => {
  const h = setup();
  let fail = true,
    charged = 0;
  let admissions = 0;
  const settled = new Set<string>();
  const credits = {
    async refusal() { admissions++; return undefined; },
    async debit(_tenant: string, _person: string, _bucket: string, usd: number, key: string) {
      if (fail) throw new Error("credit store unavailable");
      if (settled.has(key)) return;
      settled.add(key);
      charged += usd;
    },
  };
  const subject = {
    ...scope,
    identity: { subject: "person" },
    bucket: "audio",
  };
  await assert.rejects(
    transcribeAttachments({} as never, h.storage, subject, [file], {
      ...h.host,
      credits,
    }),
    /credit store unavailable/,
  );
  assert.equal(h.calls(), 1);
  assert.equal(
    [...h.rows.keys()].filter((key) => key.startsWith("transcription-billing:"))
      .length,
    1,
  );
  fail = false;
  const retried = await transcribeAttachments(
    {} as never,
    h.storage,
    subject,
    [file],
    { ...h.host, credits },
  );
  assert.equal(retried[0].transcript?.text, "A transcript");
  assert.equal(h.calls(), 1);
  assert.equal(admissions, 1);
  assert.equal(charged, 0.05);
});
