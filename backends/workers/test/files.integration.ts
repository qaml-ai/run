import { fileURLToPath } from "node:url";
import {gunzipSync} from 'node:zlib';
import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";
const token = "local-integration-only-token-with-at-least-32-characters";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8DwH4TBFAAq4wX7r7Yr4AAAAABJRU5ErkJggg==",
  "base64",
);
test(
  "repo files, retired volume routes and signed images",
  { timeout: 180000 },
  async (t) => {
    const fixture = await startFixture({entrypoint:fileURLToPath(new URL("./camelfs-worker.ts",import.meta.url))});
    const worker = fixture.worker;
    t.after(() => fixture.stop());
    const call = async (path: string, options: RequestInit = {}) =>
      fetch(worker.url + path, {
        ...options,
        headers: { authorization: `Bearer ${token}`, ...options.headers },
        signal: AbortSignal.timeout(20000),
      });
    try {
      await t.test('stored legacy mounts refuse use and remain replaceable',async()=>{
        const make=async(path:string,value:unknown)=>{const r=await call(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});assert.ok(r.ok,await r.clone().text());return await r.json() as any;};
        const agent=await make('/v1/agents',{});
        const injected=await call('/__test/stored-legacy-mount',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:agent.id})});
        assert.ok([200,409].includes(injected.status),await injected.clone().text());
        const mounts=await (await call(`/v1/agents/${agent.id}/mounts`)).json() as any[];
        const refused=await call(`/v1/agents/${agent.id}/files/workspace/old.txt`);
        assert.equal(refused.status,409,await refused.clone().text());
        assert.match(await refused.text(),new RegExp(`Mount of volume ${mounts[0].volumeId} at /workspace is retired`));
        // The worker's log line arrives through its output stream after the response: wait for it.
        for(let i=0;i<100&&!worker.logs().includes('legacy_volume_mount_refused');i++)await new Promise(resolve=>setTimeout(resolve,50));
        assert.ok(worker.logs().includes('legacy_volume_mount_refused'));
        assert.deepEqual(await (await call(`/v1/agents/${agent.id}/mounts`)).json(),mounts);
        const repo=await make('/v1/repos',{name:'replacement'});
        const replaced=await call(`/v1/agents/${agent.id}/mounts`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mounts:[{repo:repo.id,path:'/workspace',mode:'rw'}],remount:true})});
        assert.equal(replaced.status,200,await replaced.clone().text());
      });
      await t.test('repo tool-file URLs retain immutable files and directory archives',async()=>{
        const created=await call('/v1/agents',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'repo-tool-links'},body:JSON.stringify({})});
        assert.equal(created.status,201,await created.clone().text());
        const agent=(await created.json() as any).id;
        const path=`/v1/agents/${agent}/files/workspace`;
        const put=async(name:string,text:string)=>assert.equal((await call(`${path}/${name}`,{method:'PUT',body:text})).status,201);
        await put('one.txt','original one');await put('nested/two.txt','original two');
        const link=async(directory:boolean)=>{
          const r=await call('/__test/agent-tool-file',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent,path:directory?'/workspace':'/workspace/one.txt',directory})});
          assert.equal(r.status,200,await r.clone().text());return (await r.json() as any).uri;
        };
        const file=await link(false),archive=await link(true);
        assert.match(new URL(file).pathname,/^\/v1\/files\//);
        await put('one.txt','replacement');await put('nested/two.txt','changed');
        const downloaded=await fetch(file);assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),'original one');
        const tar=await fetch(archive);assert.equal(tar.status,200);
        const contents=gunzipSync(Buffer.from(await tar.arrayBuffer())).toString();
        assert.ok(contents.includes('one.txt'));assert.ok(contents.includes('nested/two.txt'));
        assert.ok(contents.includes('original one'));assert.ok(contents.includes('original two'));assert.ok(!contents.includes('replacement'));
        const mounts=await (await call(`/v1/agents/${agent}/mounts`)).json() as any[];
        const refs=await (await call(`/v1/repos/${mounts[0].repo}/refs`)).json() as any;
        assert.equal(refs.length,1,'directory links create no snapshot refs');
      });
      await t.test("retired endpoints bypass authentication and idempotency", async () => {
        const error = { error: "Volumes are replaced by repos: use /v1/repos", code: "gone" };
        for (const [path, method] of [["/v1/volumes", "GET"], ["/v1/volumes", "POST"], ["/v1/volumes/old/files/a/b", "DELETE"]]) {
          const response = await fetch(fixture.url + path, { method, headers: { "Idempotency-Key": "ignored" } });
          assert.equal(response.status, 410);
          assert.deepEqual(await response.json(), error);
        }
      });
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
            token: string;
          };
          const sent = await call(`/clients/${agent.id}/requests`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${agent.token}` },
            body: JSON.stringify({
              id: "image-turn",
              method: "prompt",
              params: { text: "inspect", images: [reference] },
            }),
          });
          assert.equal(sent.status, 202, await sent.clone().text());
          const settled = await call(
            `/clients/${agent.id}/requests/image-turn?wait=20`,
            { headers: { authorization: `Bearer ${agent.token}` } },
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
