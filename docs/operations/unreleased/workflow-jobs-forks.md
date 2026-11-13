### Workflow branches and job outputs

On Workers, `agent(prompt, { repo })` gives each child a branch at `/repo`.
`repo` is a repo id or `{ repo, ref? | version? }`. The answer includes
`fork: { repo, ref, base: { ref?, version } }`.

`commit(result.fork)` merges onto the base ref. It answers
`{ committed: true, version, changed, files? }` or `{ committed: false, conflicts }`.
A fork of a bare version cannot merge back. `snapshot` is no longer accepted.
Workflow refs are removed at the end; cached results retain separate refs for 3 days.

A job's streams and outputs are kept in one commit under `jobs/<id>/` in the
workflow's repo. Its result names `repo` and `version`.
String `job({ at })` and `push({ volume, repo, branch, app })` still accept volumes.
