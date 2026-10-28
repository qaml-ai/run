# Vendored Pi

camelRun runs on [Pi](https://github.com/earendil-works/pi) (MIT) built from a commit of its main branch, not from an
npm release, so a fix or change on Pi's main reaches us without waiting for a release. The built packages live in
`vendor/pi/` and `package.json` installs them from there:

| Tarball | Package | Why |
|---|---|---|
| `pi-durable.tgz` | `@earendil-works/pi-durable` | the agent loop, journal, tasks and compaction |
| `pi-ai.tgz` | `@earendil-works/pi-ai` | providers, model catalog, message types |
| `chord.tgz` | `@earendil-works/chord` | contexts, documents and SQLite for pi-durable |
| `pi-codemode.tgz` | `@earendil-works/pi-codemode` | a dependency of pi-durable |
| `pi-telemetry.tgz` | `@earendil-works/pi-telemetry` | a dependency of pi-durable, pi-ai and chord |
| `pi-agent-core.tgz` | `@earendil-works/pi-agent-core` | devDependency: we import only its types (`AgentMessage`, `AgentTool`, `StreamFn`) |

Each package's version is Pi's with the commit appended (`1.4.0-main.02a2b2532d8f`; the script stamps it from the
next bump on, so the packages vendored first still say `1.4.0`), which tells the lockfile, pi-ai's `User-Agent` and
telemetry a vendored build from the npm release. `vendor/pi/PI_COMMIT` names the commit, its date, and the upstream changes since the commit vendored before it.
`vendor/pi/LICENSE` is Pi's MIT notice. `package.json` `overrides` pin every `@earendil-works/*` package, also the ones
only Pi's packages depend on, to these tarballs, so nothing of Pi comes from npm (`package-lock.json` resolves each to
`file:vendor/pi/…` with its integrity hash).

What uses them: `npm ci` (CI, the Docker image, which copies `vendor/pi` before installing, and self-hosting from
source). The published SDKs (`@camelai/run` and the packages built on it) do not depend on Pi, so nothing of it is
published to npm. The self-host image is the runtime image, which has Pi installed.

## Bumping Pi

1. Pick a commit on Pi's main (its full sha) and run, from a clean checkout:

   ```sh
   scripts/vendor-pi.sh <sha>
   npm install
   ```

   The script fetches only that commit into a temporary directory outside the repository, installs Pi's dependencies
   with its own lockfile (`npm ci`, no install scripts), builds the six packages, packs each into `vendor/pi/`, and
   rewrites `PI_COMMIT` and `LICENSE`. It stops when one of them depends on a Pi package it does not ship (add it to the
   list in the script, to `overrides`, and to the table above) or when a package's license is not MIT. `npm install`
   updates `package-lock.json` with the new tarballs' integrity.
2. Review the upstream changes: the `changes` link in `PI_COMMIT`, and the `[Unreleased]` sections of
   `packages/durable/CHANGELOG.md` and `packages/ai/CHANGELOG.md` there. Look for breaking changes, new document or task
   versions (below), and new dependencies (their licenses must be permissive, see `CONTRIBUTING.md`).
3. `npm run typecheck`, then the Pi suites one file at a time (`pi-durable-*`, `agent-host`, `compaction`,
   `landed-compaction`, `close-turn-at-load`, `history-pages`, `stream-deltas`, `loop-reliability`), then `npm test`
   and `AGENT_HOSTING=inline npm test`, and `npm run sim` when recovery changed.
4. Open a PR with the sha, the upstream changes that matter to us, and a release note in `docs/operations/unreleased/`.

pi-ai's build generates its model catalog from upstream sources (models.dev, OpenRouter, Vercel AI Gateway) when the
script runs, so two runs at the same commit can differ in catalog data: the tarball keeps the snapshot it was built
with, and the lockfile's integrity keeps everyone on it. Models we price ourselves keep their overrides
(`src/pi-catalog.ts`).

## Versions that cannot be rolled back

Pi versions its documents and tasks (`pi.live`, `pi.tool`, `pi.generation`, and others). A newer Pi reads and migrates
what an older one stored, but an older one cannot read a newer version: it fails to open the session ("Document … has
newer version …"), and leaves a newer task blocked (`task_too_old`). Before merging a bump, compare the `version:` of
each `defineDoc`/`defineTask` in `packages/durable/src/harness/` with the commit vendored before. When one moved:

- the deploy cannot be rolled back: every session a new node touched fails to load on the old code until the new
  code serves it again. Roll forward instead.
- the old code writes before it refuses: loading an agent whose turn is open (its node died or handed it off
  mid-turn), the host repairs or closes that turn in the journal (`src/agent-host.ts`, before `Harness.open`), then
  Pi's open fails. That turn ends instead of resuming on the next owner.
- during the rolling deploy, a session a new node touched and an old node loads next fails that load, and its open
  turn, if any, fails. Old nodes take new agents only until the new deployment is up (then they retire), and an agent
  unloads after 5 minutes idle, so it needs a slow rollout or a new node that dies or drains mid-turn. An ECS rollback
  (circuit breaker or deployment alarm) turns it into an outage for those sessions until the next deploy, and fails
  their running turns.

Say so in the PR and the release note, and deploy when someone can roll forward at once.
