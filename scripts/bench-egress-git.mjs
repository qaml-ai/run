// Run on a Sprite. Local fixtures only: clone the same packed repository through the gateway.
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { forwardEgress } from '../backends/workers/src/computers/egress.ts';
const root = await mkdtemp(join(tmpdir(), 'egress-clone-'));
const run = (args) => new Promise((resolve, reject) => {
  const p = spawn('git', args, { cwd: root, stdio: ['ignore','ignore','pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_TERMINAL_PROMPT:'0' } });
  let error=''; p.stderr.on('data', x => error += x);
  p.on('exit', code => code ? reject(new Error(error)) : resolve());
});
let server;
try {
  await run(['init','source']);
  await writeFile(join(root,'source','data.bin'), randomBytes(16*1024*1024));
  await run(['-C','source','add','.']);
  await run(['-C','source','-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-qm','fixture']);
  await run(['clone','--bare','source','repo.git']);
  await run(['--git-dir=repo.git','repack','-ad']);
  await run(['--git-dir=repo.git','update-server-info']);
  server = createServer(async (req,res) => {
    try {
      const target = new URL(req.url,'https://github.com');
      const response = await forwardEgress(new Request(target), {host:'github.com',auth:{type:'github-app',app:'fixture'},scheme:'basic'}, {
        credential:async()=>({token:'ghs_fixture_token_never_echoed',refused(){}}),
        send:async request=> {
          const path = join(root, new URL(request.url).pathname);
          const bytes = await readFile(path);
          return new Response(bytes,{headers:{'content-type':path.endsWith('.pack')?'application/x-git-packed-objects':'text/plain','content-length':String((await stat(path)).size),etag:'"fixture"'}});
        }
      });
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
    } catch { res.writeHead(404).end(); }
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  const samples=[];
  for(let i=0;i<3;i++) {
    const started=performance.now();
    await run(['clone','-q',`http://127.0.0.1:${server.address().port}/repo.git`,`clone-${i}`]);
    const seconds=(performance.now()-started)/1000;
    samples.push({seconds,MiBPerSecond:16/seconds});
  }
  console.log(JSON.stringify({fixtureMiB:16,samples}));
} finally {server?.close();await rm(root,{recursive:true,force:true});}
