import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";
const token = "local-integration-only-token-with-at-least-32-characters";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8DwH4TBFAAq4wX7r7Yr4AAAAABJRU5ErkJggg==",
  "base64",
);
test(
  "R2 files, volume ordering, retained snapshots, signed images and restart",
  { timeout: 180000 },
  async (t) => {
    const fixture = await startFixture();
    const worker = fixture.worker;
    t.after(() => fixture.stop());
    const call = async (path: string, options: RequestInit = {}) =>
      fetch(worker.url + path, {
        ...options,
        headers: { authorization: `Bearer ${token}`, ...options.headers },
        signal: AbortSignal.timeout(20000),
      });
    try {
      const create = await call("/v1/volumes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "files experiment" }),
      });
      assert.equal(create.status, 201, await create.clone().text());
      const { id } = (await create.json()) as {
        id: string;
      };
      const base = `/v1/volumes/${id}`;
      await t.test(
        "conditional concurrent writers have exactly one winner",
        async () => {
          const initial = await call(base + "/files/hello.txt", {
            method: "PUT",
            body: "initial",
            headers: { "content-type": "text/plain", "if-none-match": "*" },
          });
          assert.equal(initial.status, 201);
          const { version } = (await initial.json()) as {
            version: number;
          };
          const writes = await Promise.all(
            ["writer one", "writer two"].map((body) =>
              call(base + "/files/hello.txt", {
                method: "PUT",
                body,
                headers: { "if-match": String(version) },
              }),
            ),
          );
          assert.deepEqual(writes.map((r) => r.status).sort(), [201, 412]);
          const read = await call(base + "/files/hello.txt");
          assert.ok(["writer one", "writer two"].includes(await read.text()));
          const range = await call(base + "/files/hello.txt", {
            headers: { range: "bytes=0-5" },
          });
          assert.equal(range.status, 206);
          assert.equal(await range.text(), "writer");
        },
      );
      await t.test(
        "snapshot keeps immutable bytes after overwrite and restart",
        async () => {
          const saved = await (await call(base + "/files/hello.txt")).text();
          const snap = await call(base + "/snapshots", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"name":"saved"}',
          });
          assert.equal(snap.status, 201);
          const snapshot = (await snap.json()) as {
            id: string;
          };
          assert.equal(
            (
              await call(base + "/files/hello.txt", {
                method: "PUT",
                body: "changed",
              })
            ).status,
            201,
          );
          const bulk = await call(
            base + "/files?content=true&snapshot=" + snapshot.id,
          );
          assert.equal(bulk.status, 200);
          const snapshotContents = (await bulk.json()) as {
            files: { path: string; data: string }[];
          };
          assert.equal(
            Buffer.from(
              snapshotContents.files.find((file) => file.path === "/hello.txt")!
                .data,
              "base64",
            ).toString(),
            saved,
          );
          await worker.stop(true);
          await worker.start();
          assert.equal(
            await (
              await call(base + "/files/hello.txt?snapshot=" + snapshot.id)
            ).text(),
            saved,
          );
          assert.equal(
            (
              await call(base + "/restore", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ snapshot: snapshot.id }),
              })
            ).status,
            200,
          );
          assert.equal(
            await (await call(base + "/files/hello.txt")).text(),
            saved,
          );
        },
      );
      await t.test(
        "file control JSON rejects an oversized body before parsing",
        async () => {
          const oversized = await call("/v1/volumes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "x".repeat(65536) }),
          });
          assert.equal(oversized.status, 413);
        },
      );
      await t.test(
        "capabilities are signed, immutable and do not require API credentials",
        async () => {
          const response = await call(base + "/links", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"path":"/hello.txt","expiresIn":60}',
          });
          assert.equal(response.status, 201);
          const link = (await response.json()) as {
            url: string;
          };
          const content = await fetch(link.url);
          assert.equal(content.status, 200);
          assert.match(await content.text(), /^writer /);
          const url = new URL(link.url);
          url.pathname = url.pathname.replace(
            /\/([^/]+)\/file$/,
            (whole, signature: string) =>
              `/${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}/file`,
          );
          assert.equal((await fetch(url)).status, 403);
        },
      );
      await t.test(
        "stored image derivative yields bounded base64 and signed URL",
        async () => {
          const uploaded = await call("/v1/images", {
            method: "POST",
            headers: { "content-type": "image/png" },
            body: png,
          });
          assert.equal(uploaded.status, 201, await uploaded.clone().text());
          const reference = (await uploaded.json()) as Record<string, unknown>;
          assert.equal(reference.type, "image_ref");
          assert.equal(reference.mimeType, "image/jpeg");
          assert.equal("data" in reference, false);
          const prepare = async (images: unknown[], urlSupport = false) =>
            call("/v1/images/prepare", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ images, urlSupport }),
            });
          const materialized = await prepare([reference]);
          assert.equal(materialized.status, 200);
          const data = (await materialized.json()) as {
            content: {
              type: string;
              data: string;
            }[];
          };
          assert.equal(data.content[0].type, "image");
          assert.ok(Buffer.from(data.content[0].data, "base64").length > 0);
          const urls = await prepare([reference], true);
          const result = (await urls.json()) as {
            content: {
              image_url: string;
            }[];
          };
          assert.equal((await fetch(result.content[0].image_url)).status, 200);
          assert.equal(
            (await prepare([{ ...reference, tenant: "another-tenant" }]))
              .status,
            400,
          );
          assert.equal(
            (await prepare([{ ...reference, size: 10 * 1024 * 1024 }])).status,
            400,
          );
          const replay = await call("/v1/images", {
            method: "POST",
            body: png,
          });
          assert.deepEqual(await replay.json(), reference);
          const created = await call("/v1/agents", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"model":"test/echo"}',
          });
          assert.equal(created.status, 201);
          const agent = (await created.json()) as {
            id: string;
          };
          const sent = await call(`/clients/${agent.id}/requests`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: "image-turn",
              method: "prompt",
              params: { text: "inspect", images: [reference] },
            }),
          });
          assert.equal(sent.status, 202, await sent.clone().text());
          const settled = await call(
            `/clients/${agent.id}/requests/image-turn?wait=20`,
          );
          const completion = (await settled.json()) as {
            outcome?: {
              result?: {
                reply?: string;
              };
            };
          };
          assert.equal(completion.outcome?.result?.reply, "Echo: inspect");
          const history = await (
            await call(`/v1/agents/${agent.id}/history`)
          ).text();
          assert.ok(history.includes(String(reference.key)));
          assert.ok(!history.includes("/v1/files/"));
          assert.ok(!history.includes(data.content[0].data));
        },
      );
    } catch (error) {
      t.diagnostic(worker.logs());
      throw error;
    }
  },
);
