#!/usr/bin/env node
// sprite-ci: CI's gates for one commit on the sprite pool, posted as the `sprite-ci` commit status. For when GitHub
// Actions is down or stalled (docs/operations/sprite-ci.md). It runs each gate through scripts/sprite-test, keeps every
// log, reads the results (each gate's exit is its verdict; the TAP totals and failing tests are the summary), and posts
// pending, then success or failure, on the commit with `gh api`.
//
//   scripts/sprite-ci.mjs 818                 # PR #818's head: every gate, status posted
//   scripts/sprite-ci.mjs 818 --comment       # the same, plus a PR comment with each gate's results (the status links it)
//   scripts/sprite-ci.mjs 5aa981b8 --gates=workers-unit,workers-integration --no-status
//   scripts/sprite-ci.mjs --list              # the gates and what each runs
//
// Options: --gates=a,b (default: all), --no-status (post nothing), --comment, --out=DIR (default
// ~/.cache/sprite-ci/<sha>), --context=NAME (default sprite-ci). Exit 0 when every gate passed, 1 otherwise.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRIP = "--experimental-strip-types --disable-warning=ExperimentalWarning";

/**
 * CI's required jobs (.github/workflows/ci.yml, workers-tests.yml), each as one scripts/sprite-test call. Not here:
 * the image build and publish (Docker image, ECR) and the reuse of an already-tested tree; see the operations doc.
 */
export const GATES = {
  full: { what: "the full Node suite, 8 shards (ci.yml test)", args: [] },
  "workers-unit": { what: "Workers unit suite (workers-tests.yml)", args: ["bash", "backends/workers/scripts/validate-sprite.sh", "unit"] },
  "workers-integration": { what: "Workers integration suite, 3 shards (workers-tests.yml)", shards: 3, args: ["bash", "backends/workers/scripts/validate-sprite.sh", "integration", "{shard}/{shards}"] },
  checks: {
    what: "typecheck, UI tests, console and studio builds, the ECS deploy script test, Workers generated copies (ci.yml checks)",
    args: ["bash", "-c", `set -e; node ${STRIP} --test infra/ecs-deploy.test.ts; npm run typecheck; npm run test:ui; npm run build:console; npm run build; cd backends/workers; npm ci --no-audit --no-fund >/dev/null; npm run -s check:reuse`],
  },
  docs: {
    what: "CI's own scripts, docs and OpenAPI tests (ci.yml docs)",
    // A sprite's checkout is the tree without .git; ci-reuse's tests read HEAD^{tree}, so the gate commits the tree to
    // a throwaway repository first (.gitignore applies, so its tree is the commit's) and removes it after.
    args: ["bash", "-c", `set -e; git init -q; trap 'rm -rf .git' EXIT; git add -A; git -c user.name=sprite-ci -c user.email=sprite-ci@localhost commit -qm tree --no-verify; node ${STRIP} --test scripts/ci-reuse.test.cjs scripts/ci-changes.test.ts scripts/ci-workflow.test.ts scripts/test-select.test.ts scripts/test-shard.test.ts scripts/test-files.test.ts tests/docs.test.ts tests/openapi.test.ts tests/openapi-sources.test.ts`],
  },
  sim: { what: "the simulator's fixed seeds, twice each (ci.yml sim)", args: ["bash", "-c", "npm run -s sim -- --seeds 1-10 --twice --jobs \"$(nproc)\""] },
  python: {
    what: "the Python SDK tests (ci.yml python)",
    args: ["bash", "-c", "set -e; [ -x \"$HOME/.sprite-ci-python/bin/python3\" ] || python3 -m venv \"$HOME/.sprite-ci-python\"; \"$HOME/.sprite-ci-python/bin/pip\" install -q -r clients/python/requirements.txt; PATH=\"$HOME/.sprite-ci-python/bin:$PATH\" npm run test:python"],
  },
};

const PREFIX = String.raw`^(?:\[\d+\/\d+\] )?`;

/** One gate's log, read: its TAP totals (summed over shards and runs), its top-level failures and its shards' exits. */
export function readLog(text) {
  const totals = { pass: 0, fail: 0, cancelled: 0 }, failures = [], exits = [];
  for (const line of text.split("\n")) {
    let match = new RegExp(`${PREFIX}# (pass|fail|cancelled) (\\d+)\\s*$`).exec(line);
    if (match) { totals[match[1]] += Number(match[2]); continue; }
    // Top level only: a subtest's `not ok` is indented and is counted by its parent.
    match = new RegExp(`${PREFIX}not ok \\d+ - (.*)$`).exec(line);
    if (match) { failures.push(match[1].trim()); continue; }
    match = new RegExp(`${PREFIX}== exit (\\d+) in (\\d+)s on (\\S+?);?(?:\\s|$)`).exec(line);
    if (match) exits.push({ code: Number(match[1]), seconds: Number(match[2]), sprite: match[3] });
  }
  return { totals, failures: [...new Set(failures)], exits };
}

/** A gate's verdict: its exit decides; a failure the run's own retry recovered is said, not counted against it. */
export function verdict(name, exit, log) {
  const ok = exit === 0;
  const counts = log.totals.pass + log.totals.fail + log.totals.cancelled > 0 ? `${log.totals.pass}/${log.totals.fail}` : ok ? "ok" : "failed";
  const note = ok && log.failures.length ? ` (${log.failures.length} retried)` : "";
  return { name, ok, exit, counts, note, failures: log.failures, exits: log.exits, totals: log.totals };
}

/** The status description, at most 140 characters (GitHub's limit): failures first, then the passes. */
export function describe(results) {
  const failed = results.filter(result => !result.ok), passed = results.filter(result => result.ok);
  const parts = [...failed.map(result => `${result.name} FAILED ${result.counts}`), ...passed.map(result => `${result.name} ${result.counts}`)];
  const head = failed.length ? `${failed.length}/${results.length} gates failed: ` : `${results.length}/${results.length} gates passed: `;
  let text = head + parts.join(", ");
  if (text.length > 140) text = `${text.slice(0, 137)}...`;
  return text;
}

/** The PR comment: one row per gate, then each failing gate's failing tests. */
export function report(sha, results, out) {
  const rows = results.map(result => `| ${result.ok ? "pass" : "**FAIL**"} | \`${result.name}\` | ${result.counts}${result.note} | ${result.exits.map(exit => `${exit.code} in ${exit.seconds}s on ${exit.sprite}`).join("<br>") || `exit ${result.exit}`} |`);
  const failing = results.filter(result => result.failures.length).map(result => `**${result.name}**${result.ok ? " (passed on the run's retry)" : ""}:\n${result.failures.slice(0, 20).map(name => `- ${name}`).join("\n")}`);
  return [
    `### sprite-ci on \`${sha.slice(0, 12)}\``,
    "",
    "| result | gate | pass/fail | shards (exit, time, sprite) |",
    "|---|---|---|---|",
    ...rows,
    ...(failing.length ? ["", ...failing] : []),
    "",
    `Logs on the runner's machine: \`${out}\`. Not covered: the image build and publish (docs/operations/sprite-ci.md).`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = { status: true, comment: false, gates: Object.keys(GATES), context: "sprite-ci" };
  for (const arg of argv) {
    if (arg === "--no-status") options.status = false;
    else if (arg === "--comment") options.comment = true;
    else if (arg === "--list") options.list = true;
    else if (arg.startsWith("--gates=")) options.gates = arg.slice(8).split(",").filter(Boolean);
    else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--context=")) options.context = arg.slice(10);
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else options.target = arg;
  }
  for (const gate of options.gates) if (!GATES[gate]) throw new Error(`Unknown gate ${gate}; the gates are ${Object.keys(GATES).join(", ")}`);
  return options;
}

const run = (command, args) => execFileSync(command, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The commit to test, and its PR when the target is a PR number (its head is fetched so sprite-test can sync it). */
function resolveTarget(target) {
  if (!target) throw new Error("Name a PR number or a commit");
  if (/^\d+$/.test(target)) {
    const pr = JSON.parse(run("gh", ["pr", "view", target, "--json", "headRefOid,number"]));
    run("git", ["fetch", "-q", "origin", `pull/${pr.number}/head`]);
    return { sha: pr.headRefOid, pr: pr.number };
  }
  return { sha: run("git", ["rev-parse", "--verify", `${target}^{commit}`]) };
}

function postStatus(sha, state, description, context, targetUrl) {
  const args = ["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${description}`];
  if (targetUrl) args.push("-f", `target_url=${targetUrl}`);
  try { run("gh", args); return true; }
  catch (error) { console.error(`sprite-ci: could not post the ${state} status: ${String(error.stderr || error.message).trim()}`); return false; }
}

function runGate(name, sha, out) {
  const gate = GATES[name], file = join(out, `${name}.log`);
  const args = [...(gate.shards ? [`--shards=${gate.shards}`] : []), sha, ...gate.args];
  const log = createWriteStream(file);
  const started = Date.now();
  console.log(`sprite-ci: ${name} started (${gate.what}); log ${file}`);
  return new Promise(done => {
    const child = spawn(join(repo, "scripts/sprite-test"), args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("close", code => {
      log.end(() => {
        const result = verdict(name, code ?? 1, readLog(readFileSync(file, "utf8")));
        writeFileSync(join(out, `${name}.json`), JSON.stringify(result));
        console.log(`sprite-ci: ${name} ${result.ok ? "passed" : "FAILED"} ${result.counts}${result.note} in ${Math.round((Date.now() - started) / 1000)}s`);
        done(result);
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const [name, gate] of Object.entries(GATES)) console.log(`${name.padEnd(20)} ${gate.what}`);
    return 0;
  }
  const { sha, pr } = resolveTarget(options.target);
  const out = resolve(options.out ?? join(homedir(), ".cache/sprite-ci", sha));
  mkdirSync(out, { recursive: true });
  console.log(`sprite-ci: ${sha}${pr ? ` (PR #${pr})` : ""}, gates ${options.gates.join(", ")}`);
  if (options.status) postStatus(sha, "pending", `Running on the sprite pool: ${options.gates.join(", ")}`.slice(0, 140), options.context);
  // A gate rerun starts as failed: a run cut short never leaves an earlier pass of it standing.
  for (const name of options.gates) writeFileSync(join(out, `${name}.json`), JSON.stringify(verdict(name, 1, readLog(""))));
  await Promise.all(options.gates.map(name => runGate(name, sha, out)));
  // Every gate's latest result for this commit: a rerun of some gates (--gates) reports and posts them with the others'
  // earlier results, so the status always covers every gate that ran on this commit.
  const results = Object.keys(GATES).filter(name => readdirSync(out).includes(`${name}.json`)).map(name => JSON.parse(readFileSync(join(out, `${name}.json`), "utf8")));
  const body = report(sha, results, out), description = describe(results);
  const passed = results.every(result => result.ok);
  console.log(`\n${body}\n`);
  let url;
  if (options.comment && pr) {
    try { url = JSON.parse(run("gh", ["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr}/comments`, "-f", `body=${body}`])).html_url; }
    catch (error) { console.error(`sprite-ci: could not comment: ${String(error.stderr || error.message).trim()}`); }
  }
  if (options.status && postStatus(sha, passed ? "success" : "failure", description, options.context, url)) console.log(`sprite-ci: posted ${passed ? "success" : "failure"} as ${options.context} on ${sha.slice(0, 12)}`);
  return passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), error => { console.error(`sprite-ci: ${error.message}`); process.exit(2); });
}
