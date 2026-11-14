import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { AgentRuntime, fileBytes } from "../../../clients/typescript.ts";
import { startFixture } from "./fixture.ts";

test(
  "projects preserve checked versions, labels, keyed identity, archive bytes and import snapshots",
  { timeout: 180000 },
  async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.stop());
    const sdk = new AgentRuntime({ url: fixture.url, apiKey: fixture.token });
    const project = await sdk.projects.create({
      key: "project-fixture",
      template: {
        "bot.ts": "export const version=1;\n",
        "data.bin": new Uint8Array([0, 255, 1]),
      },
    });
    assert.equal(
      (
        await sdk.projects.create({
          key: "project-fixture",
          template: { "bot.ts": "not overwritten" },
        })
      ).id,
      project.id,
    );
    assert.equal(
      await project.volume.readText("bot.ts"),
      "export const version=1;\n",
    );
    const saved = await project.publish({
      pin: true,
      labels: { release: "v1" },
      store: (files) => files.map((f) => f.path),
    });
    assert.ok(saved.ok);
    assert.equal(saved.version.pinned, true);
    assert.deepEqual(saved.stored, ["/bot.ts", "/data.bin"]);
    await project.volume.write("bot.ts", "export const version=2;\n");
    const one = await project.files({ version: saved.version.id });
    assert.equal(
      new TextDecoder().decode(fileBytes(one.files[0])),
      "export const version=1;\n",
    );
    assert.equal(
      (await project.versions({ labels: { release: "v1" } })).length,
      1,
    );
    await assert.rejects(
      project.volume.deleteSnapshot(saved.version.id),
      (e: { status?: number }) => e.status === 409,
    );
    const archive = await project.archive({ version: saved.version.id });
    const tar = gunzipSync(
      Buffer.from(await new Response(archive.body).arrayBuffer()),
    );
    assert.ok(tar.includes(Buffer.from("export const version=1;\n")));
    const fork = await project.volume.fork({ snapshot: saved.version.id });
    assert.equal(
      await sdk.volume(fork.id).readText("bot.ts"),
      "export const version=1;\n",
    );
    const before = await project.volume.info();
    const imported = await project.volume.snapshot({
      name: "import",
      pinned: true,
      files: { "/bot.ts": "export const version=0;\n" },
    });
    const after = await project.volume.info();
    assert.deepEqual([after.files, after.seq], [before.files, before.seq]);
    assert.equal(imported.contents?.[0].path, "/bot.ts");
    const restored = await project.restore(imported.id);
    assert.equal(restored.written, 1);
    assert.equal(restored.removed, 1);
    const same = await project.restore(imported.id);
    assert.equal(same.written, 0);
    assert.equal(same.removed, 0);
    const link = await project.volume.link("new.txt", {
      method: "PUT",
      maxBytes: 4,
      contentType: "text/plain",
    });
    assert.equal(
      (
        await fetch(link.url, {
          method: "PUT",
          body: "pass",
          headers: { "content-type": "text/plain" },
        })
      ).status,
      201,
    );
    assert.equal((await fetch(link.url, { method: "GET" })).status, 405);
    assert.equal(
      (
        await fetch(link.url, {
          method: "PUT",
          body: "too long",
          headers: { "content-type": "text/plain" },
        })
      ).status,
      413,
    );
    const gc = async (advance = 0) => {
      const response = await fetch(
        `${fixture.url}/v1/volumes/${project.id}/__gc?advance=${advance}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${fixture.token}` },
        },
      );
      assert.equal(response.status, 200);
      return (await response.json()) as {
        removed: number;
        held: number;
        candidates: number;
      };
    };
    assert.equal((await gc()).removed, 0, "first pass only marks orphans");
    assert.ok(
      (await gc(86400_010)).removed >= 1,
      "second pass collects superseded objects",
    );
    assert.equal(
      (await project.files({ version: saved.version.id })).files[0].text,
      "export const version=1;\n",
      "pinned snapshots survive collection",
    );
    const large = new Uint8Array(6 * 1024 * 1024 + 7);
    large.fill(42);
    await project.volume.write("large.bin", large);
    const largeRead = await project.volume.read("large.bin");
    assert.equal(largeRead.data.length, large.length);
    assert.equal(largeRead.data.at(-1), 42);
    // Mounting a project's volume into an agent is refused on Workers: agents mount repos
    // (test/repos.integration.ts covers repo mounts and the refusal). The Node backend keeps it.
    await assert.rejects(sdk.upsertAgent("files-builder", { tools: {}, ...project.mount("/project") }),
      (error: Error) => /Volumes are replaced by repos/.test(error.message));
    await project.volume.delete();
    await assert.rejects(
      sdk.projects.create({ key: "project-fixture" }),
      (e: { status?: number }) => e.status === 409,
    );
  },
);
