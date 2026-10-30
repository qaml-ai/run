const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const reuse = require('./ci-reuse.cjs');
const { findPassedTree } = reuse;
const context = { repo: { owner: 'qaml-ai', repo: 'run' }, runId: 99 };
const tree = 'a'.repeat(40);
const now = Date.now();
const started = new Date(now - 60_000).toISOString();
const recorded = new Date(now - 30_000).toISOString();
const required = ['CI success', 'checks', 'docs', 'python', 'sim',
  ...[1, 2, 3, 4, 5].map(shard => `test (process ${shard}/5)`)];

function fixture({ full = true, run: overrides = {}, artifact: artifactOverrides = {}, jobs, tree: target = tree } = {}) {
  const run = { id: 10, workflow_id: 1, status: 'completed', conclusion: 'success',
    repository: { full_name: 'qaml-ai/run' }, head_repository: { full_name: 'qaml-ai/run' },
    event: 'pull_request', created_at: started, run_started_at: started,
    // This SHA is deliberately not the tested merge tree.
    head_sha: 'b'.repeat(40), html_url: 'https://example.test/run/10', ...overrides };
  const artifact = { name: `ci-tested-${full ? 'full-tree' : 'tree'}-${target}`,
    expired: false, workflow_run: { id: 10 }, created_at: recorded, ...artifactOverrides };
  const actions = {
    getWorkflow: async query => {
      assert.equal(query.workflow_id, 'ci.yml');
      return { data: { id: 1 } };
    },
    listArtifactsForRepo: async query => {
      assert.ok([`ci-tested-full-tree-${target}`, `ci-tested-tree-${target}`].includes(query.name));
      return { data: { artifacts: query.name === artifact.name ? [artifact] : [] } };
    },
    getWorkflowRun: async () => ({ data: run }),
    listJobsForWorkflowRun: async () => {},
  };
  return { rest: { actions }, paginate: async (method, query) => {
    assert.equal(method, actions.listJobsForWorkflowRun);
    assert.equal(query.filter, 'latest');
    assert.equal(query.run_id, 10);
    return jobs ?? required.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  } };
}

test('reuses the recorded merge tree only after the whole run and CI success passed', async () => {
  for (const full of [true, false]) {
    assert.deepEqual(await findPassedTree({ github: fixture({ full }), context, tree, now }),
      { source: 'https://example.test/run/10', process: full });
  }
});

test('rejects failed, cancelled, incomplete, foreign, wrong-workflow and non-PR runs', async () => {
  for (const run of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress' },
    { workflow_id: 2 }, { event: 'push' }, { event: 'workflow_dispatch' },
    { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'fork/run' } },
    { head_repository: null }, { created_at: 'invalid' },
    { created_at: new Date(now + 1).toISOString() },
    { created_at: new Date(now - 14 * 86400_000 - 1).toISOString() },
    { run_started_at: new Date(now - 10_000).toISOString() }]) {
    assert.equal(await findPassedTree({ github: fixture({ run }), context, tree, now }), null, JSON.stringify(run));
  }
});

test('ignores expired, orphaned, wrong-tree, old-attempt and current-run markers', async () => {
  for (const artifact of [{ expired: true }, { workflow_run: null }, { workflow_run: { id: 99 } },
    { name: `ci-tested-full-tree-${'c'.repeat(40)}` }, { created_at: 'invalid' },
    { created_at: new Date(now - 120_000).toISOString() }]) {
    assert.equal(await findPassedTree({ github: fixture({ artifact }), context, tree, now }), null);
  }
});

test('every reused job and all process shards must have completed successfully, including CI success', async () => {
  for (const name of required) {
    for (const result of ['failure', 'cancelled', 'skipped', 'missing', 'in_progress']) {
      const jobs = required.filter(job => result !== 'missing' || job !== name).map(job => ({
        name: job, status: job === name && result === 'in_progress' ? 'in_progress' : 'completed',
        conclusion: job === name ? result : 'success',
      }));
      assert.equal(await findPassedTree({ github: fixture({ jobs }), context, tree, now }), null, `${name}: ${result}`);
    }
  }
});

test('an old marker can certify a new attempt only after that attempt records it again', async () => {
  assert.deepEqual(await findPassedTree({ github: fixture({ run: { run_attempt: 2 } }), context, tree, now }),
    { source: 'https://example.test/run/10', process: true });
});

test('missing proof and API failures leave both outputs false', async () => {
  for (const stage of ['getWorkflow', 'listArtifactsForRepo', 'getWorkflowRun', 'jobs', 'missing']) {
    const github = fixture({ tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() });
    if (stage === 'jobs') github.paginate = async () => { throw new Error('API unavailable'); };
    else if (stage === 'missing') github.rest.actions.listArtifactsForRepo = async () => ({ data: { artifacts: [] } });
    else github.rest.actions[stage] = async () => { throw new Error('API unavailable'); };
    const outputs = [];
    const core = { setOutput: (...args) => outputs.push(args), warning: () => {} };
    assert.equal(await reuse({ github, context, core }), false);
    assert.deepEqual(outputs, [['passed', 'false'], ['process', 'false']]);
  }
});

test('publishes reuse outputs only after all proof and the summary succeed', async () => {
  for (const full of [true, false]) {
    for (const summaryFailure of [true, false]) {
      const github = fixture({ full, tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() });
      const outputs = [];
      const core = { setOutput: (...args) => outputs.push(args), warning: () => {}, info: () => {},
        summary: { addRaw: () => ({ write: async () => { if (summaryFailure) throw new Error('unavailable'); } }) } };
      assert.equal(await reuse({ github, context, core }), !summaryFailure);
      assert.deepEqual(outputs, [['passed', 'false'], ['process', 'false'],
        ...summaryFailure ? [] : [['process', String(full)], ['passed', 'true']]]);
    }
  }
});
