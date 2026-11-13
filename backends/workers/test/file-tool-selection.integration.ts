import { serveFakeCamelfsd } from "./fake-camelfsd.ts";
import { fileURLToPath } from "node:url";
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { Agents } from '../../../clients/agents.ts';
import { startFixture } from './fixture.ts';

test('hidden file tools remain available to host code, while the model only receives present_file', { timeout: 120_000 }, async t => {
  const requests: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Files are available through code.' }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => {
    provider.closeAllConnections();
    return new Promise<void>(resolve => provider.close(() => resolve()));
  });
  const camelfs=await serveFakeCamelfsd("agent-file-token");
  t.after(()=>camelfs.close());
  const fixture = await startFixture({ camelfsStub:true,entrypoint:fileURLToPath(new URL("./camelfs-worker.ts",import.meta.url)),vars:{TEST_CAMELFS_URL:camelfs.url,CAMELFS_API_TOKEN:"agent-file-token"}, modelURL: `http://127.0.0.1:${(provider.address() as any).port}/v1` });
  t.after(() => fixture.stop());
  const agents = new Agents({ url: fixture.url, apiKey: fixture.token, connection: 'lazy', pollMs: 10 });
  t.after(() => agents.close());
  const agent = await agents.upsert('hidden-files', { fileTools: false });
  const executed = await agent.client.execute('await tools.write({path:"/workspace/hidden.txt",content:"from hidden tools"}); return (await tools.read({path:"/workspace/hidden.txt"})).content;', { timeoutMs: 30_000 });
  assert.equal(executed.error, undefined, JSON.stringify(executed));
  assert.match(executed.output.join('\n'), /from hidden tools/);
  assert.equal(new TextDecoder().decode((await agent.files.download('/workspace/hidden.txt')).data), 'from hidden tools');
  await agent.run('Describe the available tools.', { timeoutMs: 30_000 });
  const declared = requests.at(-1).tools.map((tool: any) => tool.function.name);
  assert.ok(declared.includes('present_file'));
  for (const name of ['read', 'write', 'edit', 'ls', 'glob', 'grep']) assert.ok(!declared.includes(name), `${name} is not offered to the model`);
  const files = (await agents.runtime.toolSources(agent.id)).find(source => source.kind === 'files');
  assert.ok(files);
  assert.equal(files.tools.find(tool => tool.name === 'read')?.exposure, 'codemode');
  assert.equal(files.tools.find(tool => tool.name === 'write')?.exposure, 'codemode');
  assert.equal(files.tools.find(tool => tool.name === 'present_file')?.exposure, 'both');
});
