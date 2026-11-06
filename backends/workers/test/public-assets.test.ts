import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicAssets } from "../scripts/public-assets.mjs";

async function directories() {
  const root = await mkdtemp(join(tmpdir(), "public-assets-"));
  const docs = join(root, "docs");
  await mkdir(docs);
  await writeFile(join(docs, "llms.txt"), "docs");
  return { root, docs, output: join(root, "out"), registry: join(root, "no-registry") };
}

test("a deploy build fails when the console is not built", async () => {
  const { root, docs, output, registry } = await directories();
  await assert.rejects(publicAssets(output, { docs, registry, console: join(root, "dist"), requireConsole: true }), /console is not built/);
  await assert.rejects(publicAssets(output, { docs, registry, requireConsole: true }), /console directory is required/);
});

test("a built console is packaged under /console", async () => {
  const { root, docs, output, registry } = await directories();
  const dist = join(root, "dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), "<html></html>");
  await writeFile(join(dist, "assets", "app.js"), "export {}");
  await publicAssets(output, { docs, registry, console: dist, requireConsole: true });
  assert.equal(await readFile(join(output, "console", "index.html"), "utf8"), "<html></html>");
  assert.equal(await readFile(join(output, "console", "assets", "app.js"), "utf8"), "export {}");
});

test("a local build may skip the console when it is not required", async () => {
  const { root, docs, output, registry } = await directories();
  await publicAssets(output, { docs, registry, console: join(root, "dist") });
});
