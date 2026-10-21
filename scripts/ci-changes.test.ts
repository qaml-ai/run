import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sha = "a".repeat(40);
const head = "b".repeat(40);
const commit = "c".repeat(40);
const tree = "d".repeat(40);

type Options = { event?: string; paths?: string[]; apiFailure?: boolean; success?: boolean; artifact?: boolean; sameTree?: boolean; sameHead?: boolean; expired?: boolean; fork?: boolean; wrongWorkflow?: boolean; greenGate?: boolean; olderRun?: boolean; secondPage?: boolean };

function changes(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
  try {
    writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { base: { sha }, head: { sha: head } } }));
    writeFileSync(join(dir, "git"), `#!/usr/bin/env bash
case "$1" in
  fetch) exit 0 ;;
  diff) printf '%s' '${(options.paths ?? ["src/server.ts"]).join("|")}' | tr '|' '\\0' ;;
  rev-parse) echo '${tree}' ;;
esac
`, { mode: 0o755 });
    const artifact = { id: 43, expired: options.expired ?? false, workflow_run: { id: 42 } };
    const artifacts = options.olderRun ? [{ ...artifact, workflow_run: { id: 41 } }, artifact] : [artifact];
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
${options.apiFailure ? "exit 1" : ""}
case "$*" in
  *artifacts/43/zip*) ${options.artifact === false ? "exit 1" : `cat '${dir}/artifact.zip'`} ;;
  *artifacts\?*)
    ${options.secondPage ? `if [[ "$*" == *page=1 ]]; then echo '${JSON.stringify({ artifacts: Array.from({ length: 100 }, () => ({ ...artifact, expired: true })) })}'; else echo '${JSON.stringify({ artifacts })}'; fi` : `echo '${JSON.stringify({ artifacts })}'`} ;;
  */jobs*) echo '${JSON.stringify({ jobs: [{ name: "CI success", conclusion: options.greenGate === false ? "failure" : "success" }] })}' ;;
  */runs/41*) echo '{"conclusion":"failure"}' ;;
  */runs/42*) echo '${JSON.stringify({ event: "pull_request", conclusion: options.success === false ? "failure" : "success", path: options.wrongWorkflow ? ".github/workflows/other.yml" : ".github/workflows/ci.yml", head_sha: head, run_attempt: 2, head_repository: { full_name: options.fork ? "someone/run" : "qaml-ai/run" } })}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, "merge.json"), JSON.stringify({ tree: options.sameTree === false ? sha : tree, commit, head: options.sameHead === false ? sha : head, pr: 1 }));
    assert.equal(spawnSync("zip", ["-q", "artifact.zip", "merge.json"], { cwd: dir }).status, 0);
    const result = spawnSync("bash", [fileURLToPath(new URL("ci-changes.sh", import.meta.url))], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, "output"), GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_EVENT_NAME: options.event ?? "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "qaml-ai/run", GITHUB_SHA: sha },
      encoding: "utf8",
    });
    return result.status === 0 ? readFileSync(join(dir, "output"), "utf8") : "tests=true\nreuse=false\nimage=true\n";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tree-indexed reuse requires a trusted successful PR run and successful aggregate check", () => {
  assert.equal(changes(), "tests=false\nreuse=true\nimage=true\n");
  for (const options of [{ apiFailure: true }, { success: false }, { artifact: false }, { sameTree: false }, { sameHead: false }, { expired: true }, { fork: true }, { wrongWorkflow: true }, { greenGate: false }]) {
    assert.equal(changes(options), "tests=true\nreuse=false\nimage=true\n", JSON.stringify(options));
  }
});

test("reuse finds older successful identical trees and paginates past expired artifacts", () => {
  assert.equal(changes({ olderRun: true }), "tests=false\nreuse=true\nimage=true\n");
  assert.equal(changes({ secondPage: true }), "tests=false\nreuse=true\nimage=true\n");
});

test("only allowlisted PR paths skip expensive tests", () => {
  for (const paths of [["docs/guide.md", "infra/terraform/main.tf", "deploy/selfhost/docker-compose.yml", ".github/ISSUE_TEMPLATE/bug.yml", "README.md"], ["docs/page.ts"]]) {
    assert.equal(changes({ event: "pull_request", paths }), "tests=false\nreuse=false\nimage=true\n");
  }
  for (const paths of [[], ["README.md", "src/server.ts"], [".github/workflows/ci.yml"], ["docs/moved.ts", "src/deleted.ts"]]) {
    assert.equal(changes({ event: "pull_request", paths }), "tests=true\nreuse=false\nimage=true\n");
  }
});

test("manual runs always test", () => {
  assert.equal(changes({ event: "workflow_dispatch" }), "tests=true\nreuse=false\nimage=true\n");
});


test("PR images follow all Dockerfile and build inputs, including removed paths", () => {
  for (const path of ["Dockerfile", ".dockerignore", "src/server.ts", "sandbox/launcher.c", "shared/types.ts", "console/src/main.tsx", "docs/guide.md", "migrations/001.sql", "package-lock.json", "clients/history-formats.ts", "packages/cli/src/main.ts", "packages/registry/public/r/item.json", "scripts/voice-check.ts", "tests/image-isolation.ts", ".github/workflows/ci.yml"]) {
    assert.match(changes({ event: "pull_request", paths: [path] }), /image=true\n$/, path);
  }
  for (const paths of [["README.md"], ["tests/voice-realtime-sessions.test.ts"], ["infra/terraform/main.tf"], ["scripts/ci-workflow.test.ts"]]) {
    assert.match(changes({ event: "pull_request", paths }), /image=false\n$/, paths.join(","));
  }
  assert.match(changes({ event: "pull_request", paths: [] }), /image=true\n$/);
});
