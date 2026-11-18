import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { AgentRuntime } from "../../clients/node.ts";
import { OPERATOR, runtime } from "../../tests/runtime-server.ts";
import { CamelRun } from "../sdk/src/index.ts";
import { migrateVolume } from "./migrate-volume.ts";

export async function rehearseMigration(t: TestContext, workerUrl: string, adminKey: string) {
  const v1 = await runtime(t, () => ({ content: "fixture" }));
  const source = new AgentRuntime({ url: v1.base, apiKey: OPERATOR });
  const { apiKey } = await CamelRun.createTenant({
    baseUrl: workerUrl,
    adminKey,
    name: "Camel Bots migration rehearsal",
    initialCreditsUsd: 10,
  });
  const target = new CamelRun({ baseUrl: workerUrl, apiKey });
  t.after(() => target.close());

  // A successful v2 write can lose its response. Recover its commit on an explicit rerun.
  let lostResponse = false;
  const interruptedTarget = new CamelRun({
    baseUrl: workerUrl,
    apiKey,
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, body: typeof init?.body === "string" ? init.body : undefined });
      if (!lostResponse && url.endsWith("/write") && response.ok) {
        lostResponse = true;
        await response.text();
        throw new Error("lost v2 write response");
      }
      return response;
    },
  });
  t.after(() => interruptedTarget.close());

  for (const bot of ["released", "saved", "new-draft"]) {
    const volume = source.volume((await source.createVolume({ name: bot })).id);
    const repo = await target.repos.create({ name: bot });
    const released = bot === "released" ? await volume.snapshot({
      name: "release:v1", pinned: true, labels: { release: "v1" },
      files: { "bot.ts": "export const version = 1;", "notes/old.md": "only in the release", "empty": "" },
    }) : null;
    const logo = new Uint8Array([0, 137, 255, 9]);
    await volume.write("assets/logo.bin", logo);
    await volume.write("notes/current.md", new Uint8Array([239, 187, 191, 97, 10]));
    await volume.write("bot.ts", "export const saved = true;");
    const saved = bot !== "new-draft" ? await volume.snapshot({ name: "published" }) : null;
    await volume.write("bot.ts", "export const draft = true;");

    if (bot === "released") {
      await assert.rejects(migrateVolume(volume, interruptedTarget, repo.repoId, repo.commit), /lost v2 write response/);
    }
    const first = await migrateVolume(volume, target, repo.repoId, repo.commit);
    assert.equal(first.seq, (await volume.info()).seq);
    assert.deepEqual(await migrateVolume(volume, target, repo.repoId, repo.commit), first);
    assert.equal((await target.repos.history(repo.repoId)).commits.length, (released ? 1 : 0) + (saved ? 1 : 0) + 2);
    assert.equal((await target.repos.read(repo.repoId, { path: "bot.ts" })).content, "export const draft = true;");

    // Simulate v1 remaining live after the first copy, including a save with an unchanged draft sequence.
    const newer = await volume.snapshot({ name: "new save" });
    const second = await migrateVolume(volume, target, repo.repoId, repo.commit);
    assert.equal(second.seq, first.seq);
    assert.ok(second.snapshotCommits[newer.id]);
    assert.notEqual(second.head, second.snapshotCommits[newer.id]);
    assert.deepEqual(await migrateVolume(volume, target, repo.repoId, repo.commit), second);
    await volume.write("bot.ts", "export const finalV1 = true;");
    await volume.remove("notes/current.md");
    const ready = await migrateVolume(volume, target, repo.repoId, repo.commit);
    assert.ok(ready.seq > first.seq);
    assert.equal(ready.seq, (await volume.info()).seq);
    if (released) assert.equal(ready.snapshotCommits[released.id], first.snapshotCommits[released.id]);
    if (saved) assert.equal((await target.repos.read(repo.repoId, { at: ready.snapshotCommits[saved.id], path: "bot.ts" })).content, "export const saved = true;");
    assert.deepEqual(Buffer.from((await target.repos.read(repo.repoId, { path: "assets/logo.bin" })).base64!, "base64"), Buffer.from(logo));

    const agent = await target.agents.upsert(bot, { repoId: repo.repoId, model: "mock/default", builtins: ["files"] });
    const read = await agent.run('Read the migrated draft [CALL:read_file {"path":"bot.ts"}]');
    assert.equal(read.status, "completed");
    assert.match(read.text, /finalV1/);

    // Once v2 accepts writes, a stale import must fail instead of overwriting the live repo.
    const edit = await agent.run('Edit the migrated draft [CALL:edit_file {"path":"bot.ts","oldString":"finalV1","newString":"firstV2"}]');
    assert.equal(edit.status, "completed");
    await assert.rejects(migrateVolume(volume, target, repo.repoId, repo.commit), /outside this import/);
    assert.equal((await target.repos.read(repo.repoId, { path: "bot.ts" })).content, "export const firstV2 = true;");
    assert.equal(await volume.readText("bot.ts"), "export const finalV1 = true;");

    if (released) {
      await target.repos.restore(repo.repoId, { targetCommit: ready.snapshotCommits[released.id]! });
      assert.equal((await target.repos.read(repo.repoId, { path: "bot.ts" })).content, "export const version = 1;");
      assert.equal((await target.repos.read(repo.repoId, { path: "empty" })).content, "");
      assert.equal((await target.repos.read(repo.repoId, { at: ready.head, path: "bot.ts" })).content, "export const finalV1 = true;");
    }
  }
}
