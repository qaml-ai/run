const { execFileSync } = require('node:child_process');

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// PR run.head_sha is the branch head, not the merge commit checkout tested.
// Only that checkout's marker, a successful run and its successful jobs are proof.
async function findPassedTree({ github, context, tree, now = Date.now() }) {
  const repo = context.repo;
  const fullName = `${repo.owner}/${repo.repo}`;
  const { data: workflow } = await github.rest.actions.getWorkflow({ ...repo, workflow_id: 'ci.yml' });
  const names = [`ci-tested-full-tree-${tree}`, `ci-tested-tree-${tree}`];
  const lists = await Promise.all(names.map(name => github.rest.actions.listArtifactsForRepo({
    ...repo, name, per_page: 100,
  })));
  // Prefer full-suite proof. Bound API work even on a frequently tested tree.
  const artifacts = lists.flatMap(({ data }) => data.artifacts.slice(0, 10));
  for (const artifact of artifacts) {
    if (artifact.expired || !names.includes(artifact.name) || !artifact.workflow_run ||
        String(artifact.workflow_run.id) === String(context.runId)) continue;
    const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: artifact.workflow_run.id });
    const age = now - Date.parse(run.created_at);
    // A marker from an earlier attempt cannot certify a rerun's test selection.
    const recorded = Date.parse(artifact.created_at) - Date.parse(run.run_started_at);
    if (run.workflow_id !== workflow.id || run.status !== 'completed' || run.conclusion !== 'success' ||
        run.repository?.full_name !== fullName || run.head_repository?.full_name !== fullName ||
        run.event !== 'pull_request' || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS ||
        !Number.isFinite(recorded) || recorded < 0) continue;
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...repo, run_id: run.id, filter: 'latest', per_page: 100,
    });
    const required = ['CI success', 'checks', 'docs', 'python', 'sim',
      ...[1, 2, 3, 4, 5].map(shard => `test (process ${shard}/5)`)];
    if (!required.every(name => jobs.some(job => job.name === name &&
        job.status === 'completed' && job.conclusion === 'success'))) continue;
    return { source: run.html_url, process: artifact.name === names[0] };
  }
  return null;
}

async function reuse({ github, context, core }) {
  core.setOutput('passed', 'false');
  core.setOutput('process', 'false');
  try {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    const proof = await findPassedTree({ github, context, tree });
    if (!proof) return false;
    core.info(`Tree ${tree} passed CI: ${proof.source} (full process suite: ${proof.process})`);
    await core.summary.addRaw(`Reused CI for tree \`${tree}\`: ${proof.source}. Full process suite: ${proof.process}.`).write();
    core.setOutput('process', String(proof.process));
    core.setOutput('passed', 'true');
    return true;
  } catch {
    // Missing proof or an API outage spends CI minutes, never grants a pass.
    core.warning('Could not verify a previous successful CI run; no result reused.');
    return false;
  }
}
module.exports = reuse;
module.exports.findPassedTree = findPassedTree;
