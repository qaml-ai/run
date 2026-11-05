/** Verify original public assertions in the product/money ports, including setup adapted to fixtures. */
import { readFile } from 'node:fs/promises';
import { parse } from '@babel/parser';

const sources = [
  'account', 'auto-topup', 'billing-alerts', 'billing-mail', 'billing-payments', 'email-signup',
  'operator-tenants', 'storage-limits', 'web-render', 'web-search', 'x-search',
  'file-arguments', 'usage-webhooks',
];
const gapSources = ['billing', 'key-scopes', 'files', 'credential-exchange', 'projects', 'webhooks', 'end-user-runs', 'end-user-reasons'];
const ast = text => parse(text, { sourceType: 'module', plugins: ['typescript'] });
const canonical = node => JSON.stringify(node, (key, value) => ['loc','start','end','extra','leadingComments','trailingComments','innerComments'].includes(key) ? undefined : value);
function assertions(node, text, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object?.name === 'assert') found.push({ key: canonical(node), text: text.slice(node.start, node.end) });
  for (const [key, value] of Object.entries(node)) if (key !== 'loc') {
    if (Array.isArray(value)) for (const child of value) assertions(child, text, found);
    else assertions(value, text, found);
  }
  return found;
}
function privateOrChannel(source, assertion) {
  if (source === 'billing') return assertion.includes('db.query(');
  if (source === 'files') return ['assert.equal(file.size,', 'assert.equal(file.chunks.length,', 'assert.ok(ahead <='].some(value => assertion.includes(value));
  if (source === 'credential-exchange') return ['stored.rows.map(', 'logged.some('].some(value => assertion.includes(value));
  if (source === 'webhooks') return assertion.includes('bodies.map(body =>');
  if (source === 'file-arguments') return assertion.includes('r.db.query(');
  if (source === 'usage-webhooks') return assertion.includes('r.db.query(') || assertion.includes('rows.rows[0].count');
  if (source === 'operator-tenants') return /kept(?:\.length|\[0\]\.body)/.test(assertion);
  if (source === 'billing-mail') return assertion.includes('r.db.query(');
  if (source === 'email-signup') return ['r.db.query(', 'stored.map(', 'stored[0].hash', 'stats.signups.', 'r.logs.some('].some(value => assertion.includes(value));
  if (source === 'account') return [
    'JSON.parse(text("discord.json"))', 'archiveText.includes(secret)', 'await count(',
    'assert.deepEqual(tombstone,', 'existsSync(',
  ].some(value => assertion.includes(value));
  return false;
}
let cases = 0, checked = 0;
for (const {source, suffix, file} of [...sources.map(source => ({source, suffix:'ported.test.ts'})), ...gapSources.map(source => ({source, suffix:'gaps.contract.test.ts'})), {source:'usage-webhooks', file:'usage-webhook-recovery.ported.test.ts'}]) {
  const path = `tests/${source}.test.ts`, original = await readFile(path, 'utf8');
  const port = await readFile(`tests/contract/areas/${file ?? `${source}.${suffix}`}`, 'utf8');
  const tests = text => {
    const found = [];
    const scan = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee?.name === 'test') { found.push(node); return; }
      for (const [key,value] of Object.entries(node)) if (key !== 'loc') {
        if (Array.isArray(value)) value.forEach(scan); else scan(value);
      }
    };
    scan(ast(text)); return found;
  };
  const originals = tests(original);
  for (const call of tests(port)) {
    const name = canonical(call.arguments[0]);
    const from = originals.find(call => canonical(call.arguments[0]) === name);
    if (!from) throw new Error(`Original case not found: ${path}: ${name}`);
    const expected = assertions(from.arguments.at(-1), original).filter(value => !privateOrChannel(source, value.text));
    const actual = assertions(call.arguments.at(-1), port);
    let cursor = 0;
    for (const expectation of expected) {
      const index = actual.findIndex((item, index) => index >= cursor && item.key === expectation.key);
      if (index === -1) throw new Error(`${path}:${from.loc.start.line}: missing original assertion: ${expectation.text}`);
      cursor = index + 1;
    }
    cases++; checked += expected.length;
  }
}
console.log(`${cases} product source test declarations retain ${checked} original public assertions.`);
