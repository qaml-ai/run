import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HostAgent } from '../../../jobhost/agent.ts';
import { fakeLauncher } from '../../../jobhost/vm.ts';
import type { Camelfsd } from '../../../jobhost/camelfsd.ts';
import type { TreeEntry } from '../src/repos/storage.ts';

/** A fake host runs real commands on trees materialized from the strict storage fake. */
function createRepoJobHost(root: string, host: string, runtime: string, secret: string, url: string, token: string) {
  const read = async (lineage: string, path: string) => {
    const response = await fetch(`${url}/v1/lineages/${encodeURIComponent(lineage)}/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.ok(response.ok, `fake host storage returned ${response.status}`);
    return response;
  };
  const launcher = fakeLauncher({ work: join(root,'jobs') });
  const daemon: Camelfsd = {
    async mount(input) {
      assert.ok(input.fence, 'repo jobs carry their lease fence');
      const image = join(root,input.jobId);
      await mkdir(image,{recursive:true});
      const tree = await read(input.lineage, `trees/${input.tree}?recursive=1`);
      const { entries } = await tree.json() as { entries: TreeEntry[] };
      for (const entry of entries) if ('blob' in entry) {
        const path = join(image,entry.path);
        await mkdir(dirname(path),{recursive:true});
        await writeFile(path,new Uint8Array(await (await read(input.lineage, `blobs/${entry.blob}?tree=${input.tree}&path=${encodeURIComponent(entry.path)}`)).arrayBuffer()),{mode:parseInt(entry.mode,8)});
      }
      return {image,warm:false,root:'test-root',tree:input.tree,mountMs:0,hydrating:false};
    },
    async release(id) { await rm(join(root,id),{recursive:true,force:true}); },
    async health() { return {ok:true,version:'test',data:root,store:root,hostId:host}; },
    async status() { throw new Error('unused'); },
  };
  return new HostAgent({ runtime,attest:async()=>({kind:'test',host,secret}),slots:2,vcpus:2,memoryMiB:8192,diskLowBytes:0,camelfsd:daemon,
    launcher:{...launcher,async boot(...args) {
      const vm = await launcher.boot(...args);
      // mount() already materialized the requested tree; no apply stream is needed.
      return {...vm,request:(request,onLog)=>request.op==='camelfs_apply'?Promise.resolve({ok:true,applyMs:0}):vm.request(request,onLog)};
    }},
  });
}

export async function repoJobHost(t: TestContext, runtime: string, secret: string, url: string, token: string) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-host-'));
  const agent = createRepoJobHost(root, 'workflow-host', runtime, secret, url, token);
  t.after(async()=>{await agent.close();await rm(root,{recursive:true,force:true});});
  await agent.start();
}

// The host-loss test starts this in a child process so it can kill the host mid-job.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [root, host, runtime, url] = process.argv.slice(2);
  const { JOB_HOST_TEST_SECRET: secret, JOB_HOST_TEST_STORAGE_TOKEN: token } = process.env;
  if (!root || !host || !runtime || !url || !secret || !token) throw new Error('Missing fake repo host configuration');
  await createRepoJobHost(root, host, runtime, secret, url, token).start();
}
