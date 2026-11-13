import { serveFakeCamelfsd } from "./fake-camelfsd.ts";
import { fileURLToPath } from "node:url";
import assert from 'node:assert/strict';
import test from 'node:test';
import { Agents } from '../../../clients/agents.ts';
import { startFixture } from './fixture.ts';

test('grep matches regular expressions in linear time, and names a pattern it cannot compile', { timeout: 120_000 }, async t => {
  const camelfs=await serveFakeCamelfsd("agent-file-token");
  t.after(()=>camelfs.close());
  const fixture = await startFixture({camelfsStub:true,entrypoint:fileURLToPath(new URL("./camelfs-worker.ts",import.meta.url)),vars:{TEST_CAMELFS_URL:camelfs.url,CAMELFS_API_TOKEN:"agent-file-token"}});
  t.after(() => fixture.stop());
  const agents = new Agents({ url: fixture.url, apiKey: fixture.token, connection: 'lazy', pollMs: 10 });
  t.after(() => agents.close());
  const agent = await agents.upsert('grep-regex');
  const lines = Array.from({ length: 30 }, (_, index) => `export const value${index} = ${index};`).join('\n');
  const executed = await agent.client.execute(`
    await tools.write({ path: "/workspace/src/values.ts", content: ${JSON.stringify(lines)} });
    await tools.write({ path: "/workspace/notes.md", content: "TODO docs\\n${'a'.repeat(5000)}b\\n" });
    const regex = await tools.grep({ pattern: "value1\\\\d = ", regex: true, limit: 200 });
    const folded = await tools.grep({ pattern: "^todo\\\\b", regex: true, ignoreCase: true });
    const backtracking = await tools.grep({ pattern: "(a+)+$", regex: true });
    const plain = await tools.grep({ pattern: "value1\\\\d", limit: 200 });
    let invalid, lookahead;
    try { await tools.grep({ pattern: "(", regex: true }); } catch (error) { invalid = String(error.message ?? error); }
    try { await tools.grep({ pattern: "a(?=b)", regex: true }); } catch (error) { lookahead = String(error.message ?? error); }
    return JSON.stringify({ regex, folded, backtracking, plain, invalid, lookahead });
  `, { timeoutMs: 30_000 });
  assert.equal(executed.error, undefined, JSON.stringify(executed));
  const result = JSON.parse(executed.output.join('\n').match(/\{.*\}/s)![0]);
  assert.deepEqual(result.regex.matches.map((match: any) => match.line), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(result.regex.matches[0], { path: '/workspace/src/values.ts', line: 11, text: 'export const value10 = 10;' });
  assert.deepEqual(result.folded.matches.map((match: any) => [match.path, match.line]), [['/workspace/notes.md', 1]]);
  assert.deepEqual(result.backtracking.matches, [], 'a pattern that backtracks catastrophically in JS answers at once');
  assert.deepEqual(result.plain.matches, [], 'without regex: true the pattern is literal text');
  assert.match(result.invalid, /Invalid regular expression: .*missing closing \)/);
  assert.match(result.lookahead, /Invalid regular expression: .*unsupported Perl syntax/);
});
