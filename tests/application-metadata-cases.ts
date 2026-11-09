import assert from "node:assert/strict";

export async function applicationMetadataCase(r: { call(path: string, init?: any): Promise<any> }) {
  const metadata = { type: "camelcode-project", repos: ["acme/app"], nested: { active: true }, numeric: 2 };
  const made = await r.call("/v1/agents", { body: { metadata, name: "Project" }, headers: { "Idempotency-Key": "metadata-project" } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  const waitMetadata = async (expected: Record<string, unknown>) => {
    for (let i = 0; i < 50; i++) {
      const current = (await r.call(`/v1/agents/${id}`)).json.metadata;
      if (JSON.stringify(current) === JSON.stringify(expected)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.metadata, expected);
  };
  const detail = await r.call(`/v1/agents/${id}`);
  assert.deepEqual(detail.json.metadata, metadata, detail.text);
  assert.equal((await r.call(`/v1/agents/${id}`, { token: "other-operator-token-at-least-24-chars" })).status, 404);
  assert.deepEqual((await r.call("/v1/agents?metadata.type=camelcode-project", { token: "other-operator-token-at-least-24-chars" })).json, []);
  const list = await r.call("/v1/agents?metadata.type=camelcode-project");
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.map((a: any) => a.id), [id]);
  assert.deepEqual(list.json[0].metadata, metadata);
  assert.equal(list.json[0].lastActiveAt, null);
  assert.equal(list.json[0].lastError, null);
  assert.deepEqual((await r.call("/v1/agents?metadata.numeric=2")).json, []);
  assert.deepEqual((await r.call("/v1/agents?metadata.type=other")).json, []);
  assert.equal((await r.call("/v1/agents?metadata.=x")).status, 400);
  for (const invalid of [null, [], "text", { large: "é".repeat(8192) }]) {
    const response = await r.call("/v1/agents", { body: { metadata: invalid } });
    assert.equal(response.status, 400, response.text);
  }
  // A legacy upsert leaves application metadata alone.
  const again = await r.call("/v1/agents", { body: { name: "Project" }, headers: { "Idempotency-Key": "metadata-project" } });
  assert.equal(again.status, 201, again.text);
  assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.metadata, metadata);
  const forbidden = await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", token: made.json.token, body: { metadata: { hacked: true } } });
  assert.ok([401, 403].includes(forbidden.status), forbidden.text);
  const update = await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { metadata: { type: "changed" } } });
  assert.equal(update.status, 202, update.text);
  for (let i = 0; i < 50; i++) {
    if ((await r.call(`/v1/agents/${id}`)).json.metadata.type === "changed") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.metadata, { type: "changed" });
  assert.deepEqual((await r.call("/v1/agents?metadata.type=camelcode-project")).json, []);
  const updated = await r.call("/v1/agents", { body: { name: "Project", metadata: { type: "upserted" } }, headers: { "Idempotency-Key": "metadata-project" } });
  assert.equal(updated.status, 201, updated.text);
  await waitMetadata({ type: "upserted" });
  const clear = await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { metadata: {} } });
  assert.equal(clear.status, 202, clear.text);
  await waitMetadata({});
}

/** A legacy upsert queued behind a metadata update must not restore the old value. */
export async function queuedMetadataCase(r: { call(path: string, init?: any): Promise<any> }, setModel: (reply: () => object) => void) {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  setModel(() => { entered.resolve(); return { role: "assistant", content: "Done", wait: finish.promise }; });
  const made = await r.call("/v1/agents", { body: { metadata: { version: "old" } }, headers: { "Idempotency-Key": "metadata-queue" } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  try {
    const prompt = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "hold" } });
    assert.equal(prompt.status, 202, prompt.text);
    await entered.promise;
    const update = await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { metadata: { version: "new" } } });
    assert.equal(update.status, 202, update.text);
    const upsert = await r.call("/v1/agents", { body: {}, headers: { "Idempotency-Key": "metadata-queue" } });
    assert.equal(upsert.status, 201, upsert.text);
    finish.resolve();
    const last = upsert.json.reconfigured?.id;
    assert.ok(last, upsert.text);
    for (let i = 0; i < 100; i++) {
      const record = await r.call(`/v1/agents/${id}/requests/${last}`);
      if (record.json.state === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.metadata, { version: "new" });
  } finally { finish.resolve(); }
}
