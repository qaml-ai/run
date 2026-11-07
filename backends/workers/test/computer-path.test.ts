import test from 'node:test';
import assert from 'node:assert/strict';
import { computerPath } from '../src/computers/tool.ts';

test('computer paths: an absolute path under /workspace is made relative; other absolute or .. paths say where paths resolve', () => {
  assert.equal(computerPath('/workspace/camelcode-scratch/src/math.js'), 'camelcode-scratch/src/math.js');
  assert.equal(computerPath('src/math.js'), 'src/math.js');
  assert.throws(() => computerPath('/tmp/pr.json'), /paths in \/workspace, relative to it.*"\/tmp\/pr.json" is outside it/);
  assert.throws(() => computerPath('../tmp/pr.json'), /is outside it/);
  assert.equal(computerPath('/workspace/'), '', 'left for the path check to refuse');
});
