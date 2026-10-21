import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sha = "a".repeat(40);
const head = "b".repeat(40);
type Options = { event?: string; paths?: string[]; apiFailure?: boolean; draft?: boolean; selectorFailure?: boolean };

function changes(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
  try {
    // The event says the opposite of the PR's live state: only the live state counts.
    writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { base: { sha }, head: { sha: head }, number: 7, draft: !options.draft } }));
    writeFileSync(join(dir, "git"), `#!/usr/bin/env bash
case "$1" in
  fetch) exit 0 ;;
  diff) printf '%s' '${(options.paths ?? ["src/server.ts"]).join("|")}' | tr '|' '\\0' ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
${options.apiFailure ? "exit 1" : ""}
case "$*" in
  *pulls/7*) echo '${options.draft ? "true" : "false"}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    if (options.selectorFailure) writeFileSync(join(dir, "node"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const result = spawnSync("bash", [fileURLToPath(new URL("ci-changes.sh", import.meta.url))], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, "output"), GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_EVENT_NAME: options.event ?? "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "qaml-ai/run", GITHUB_SHA: sha },
      encoding: "utf8",
    });
    if (!options.apiFailure && !options.selectorFailure) assert.equal(result.status, 0, result.stderr);
    return result.status === 0 ? readFileSync(join(dir, "output"), "utf8") : "tests=true\nimage=true\n";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("main always runs everything without looking up PR artifacts", () => {
  assert.equal(changes({ apiFailure: true }), "tests=true\nimage=true\n");
});

test("a live draft API failure falls back to all tests and images", () => {
  assert.equal(changes({ event: "pull_request", apiFailure: true, paths: ["README.md"] }), "tests=true\nimage=true\n");
});

test("only allowlisted PR paths skip expensive tests", () => {
  for (const paths of [["docs/guide.md", "infra/terraform/main.tf", "deploy/selfhost/docker-compose.yml", "README.md"], ["docs/page.ts"]]) {
    assert.equal(changes({ event: "pull_request", paths }), "tests=false\nimage=true\n");
  }
  for (const paths of [[], ["README.md", "src/server.ts"], [".github/workflows/ci.yml"], ["docs/moved.ts", "src/deleted.ts"]]) {
    assert.equal(changes({ event: "pull_request", paths }), "tests=true\nimage=true\n");
  }
  assert.equal(changes({ event: "pull_request", paths: [".github/ISSUE_TEMPLATE/bug.yml"] }), "tests=true\nimage=false\n");
});

test("manual runs always test", () => {
  assert.equal(changes({ event: "workflow_dispatch" }), "tests=true\nimage=true\n");
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

test("drafts, by the PR's state when the run starts, run only the fast checks and the test files their change names", () => {
  assert.equal(changes({ event: "pull_request", draft: true, paths: ["README.md"] }), "tests=false\nimage=false\ndraft=true\nquick=\n");
  const quick = changes({ event: "pull_request", draft: true, paths: ["src/model.ts", "tests/limits.test.ts", "Dockerfile", "src/nonexistent-module.ts", "docs/model.ts"] });
  assert.match(quick, /^tests=false\nimage=false\ndraft=true\nquick=tests\/limits\.test\.ts( tests\/model[-.][^ ]*\.test\.ts)+\n$/);
  assert.ok(quick.includes(" tests/model-errors.test.ts "), "src/model.ts names tests/model-*.test.ts");
  assert.match(changes({ event: "pull_request", draft: false, paths: ["src/model.ts"] }), /tests=true\nimage=true\n$/);
});

test("ready PRs publish a JSON selection while draft checks remain name-based", () => {
  const output = changes({ event: "pull_request", paths: ["tests/agent-host.test.ts"] });
  const selected = JSON.parse(output.split("selected=")[1].split("\n")[0]) as string[];
  assert.ok(selected.includes("tests/agent-host.test.ts"));
  assert.ok(selected.includes("tests/config.test.ts"));
  assert.ok(!selected.includes("tests/client-lifecycle.test.ts"));
  assert.match(output, /tests=true\nimage=false\n$/);
});

test("selector errors leave all checks enabled", () => {
  assert.equal(changes({ event: "pull_request", paths: ["tests/agent-host.test.ts"], selectorFailure: true }), "tests=true\nimage=true\n");
});
