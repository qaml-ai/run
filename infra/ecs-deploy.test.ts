// infra/ecs-deploy.sh against a simulated ECS (a fake `aws` on PATH): which revision it registers and rolls, that it never
// rolls an older commit over a newer one, that it follows a newer deployment that includes its commit, and that it
// fails when the running image is not the one it deployed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const infra = new URL("./", import.meta.url);
const registry = "904534089871.dkr.ecr.us-west-2.amazonaws.com/camelai-agent-runtime";

// The fake keeps the service, revisions and images in state.json. A deployment's tasks run one describe-services
// call after its update, are healthy from then on, and the rollout completes `completeAfter` calls in. `plan` replaces
// the primary deployment at a describe-services call (`at`) or during register-task-definition (`at: "register"`).
const fakeAws = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_ECS_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const out = (value) => { save(); process.stdout.write(typeof value === "string" ? value + "\n" : JSON.stringify(value)); process.exit(0); };
const command = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")).slice(0, 2).join(" ");
state.calls.push([command, ...args.filter((a) => a.startsWith("--task-definition") || a.startsWith("arn:"))].join(" "));
const svc = state.service;
const revisionArn = (n) => "arn:aws:ecs:us-west-2:1:task-definition/camelai-agent-runtime:" + n;
const register = (image) => { state.revisions.push(image); return revisionArn(state.revisions.length); };
const roll = (arn) => {
  for (const d of svc.deployments) d.status = "ACTIVE";
  const id = "ecs-svc/" + (++state.deploymentCount);
  svc.deployments.unshift({ id, status: "PRIMARY", taskDefinition: arn, rolloutState: "IN_PROGRESS", started: state.tick });
  svc.events.unshift({ id: "ev" + state.deploymentCount, message: "(service camelai-agent-runtime) has started 3 tasks for " + id });
};
const applyPlan = (at) => {
  for (const step of state.plan.filter((s) => s.at === at && !s.done)) step.done = true, roll(step.revision ? revisionArn(step.revision) : register(registry + ":" + step.tag));
};
const tasksOf = (d) => state.tick > d.started ? [0, 1, 2].map((i) => "arn:aws:ecs:us-west-2:1:task/c/" + d.id.split("/")[1] + "-" + i) : [];
const imageOfArn = (arn) => state.revisions[Number(arn.split(":").pop()) - 1];
const registry = ${JSON.stringify(registry)};
switch (command) {
  case "ecr describe-images": {
    const tag = opt("--image-ids").replace("imageTag=", "");
    if (!state.images.includes(tag)) { process.stderr.write("ImageNotFoundException\n"); process.exit(254); }
    out({ imageDetails: [{ imageTags: [tag], imageDigest: "sha256:" + tag }] });
  }
  case "ecs describe-services": {
    state.tick++;
    if (state.apiErrorAt === state.tick) { save(); process.exit(42); }
    applyPlan(state.tick);
    if (state.completedSeen) applyPlan("completed");
    const primary = svc.deployments.find((d) => d.status === "PRIMARY");
    if (primary.rolloutState === "IN_PROGRESS" && state.tick - primary.started >= state.completeAfter) {
      primary.rolloutState = "COMPLETED";
      svc.deployments = [primary];
    }
    if (state.failAt === state.tick) primary.rolloutState = "FAILED";
    if (primary.rolloutState === "COMPLETED" && primary.started >= 0) state.completedSeen = true;
    out({ services: [{ desiredCount: 3, events: svc.events, deployments: svc.deployments.map((d) => ({ ...d,
      runningCount: tasksOf(d).length, desiredCount: d.status === "PRIMARY" ? 3 : 0 })) }] });
  }
  case "ecs describe-task-definition": {
    const ref = opt("--task-definition");
    const arn = ref.startsWith("arn:") ? ref : revisionArn(state.revisions.length);
    if (opt("--query")) out(arn);
    out({ taskDefinition: { taskDefinitionArn: arn, revision: 1, family: "camelai-agent-runtime",
      containerDefinitions: [{ name: "agent-runtime", image: imageOfArn(arn) }] }, tags: [] });
  }
  case "ecs register-task-definition": {
    const input = JSON.parse(opt("--cli-input-json"));
    applyPlan("register");
    out(register(input.containerDefinitions[0].image));
  }
  case "ecs update-service": roll(opt("--task-definition")); out({});
  case "ecs list-tasks": {
    const by = opt("--started-by");
    const deployments = by ? svc.deployments.filter((d) => d.id === by) : svc.deployments;
    out({ taskArns: deployments.flatMap(tasksOf) });
  }
  case "ecs describe-tasks": {
    const arns = args.slice(args.indexOf("--tasks") + 1).filter((a) => a.startsWith("arn:"));
    out({ tasks: arns.map((taskArn) => {
      const d = svc.deployments.find((d) => taskArn.includes("/" + d.id.split("/")[1] + "-"));
      const image = state.taskImageOverride ?? imageOfArn(d.taskDefinition);
      return { taskArn, lastStatus: "RUNNING", taskDefinitionArn: d.taskDefinition,
        attachments: [{ details: [{ name: "privateIPv4Address", value: "ip-" + taskArn.split("/").pop() }] }],
        containers: [{ name: "agent-runtime", image, imageDigest: "sha256:" + image.split(":").pop() }] };
    }) });
  }
  case "elbv2 describe-target-groups": out("arn:tg");
  case "elbv2 describe-target-health": {
    const ips = svc.deployments.flatMap(tasksOf).map((t) => "ip-" + t.split("/").pop());
    out({ TargetHealthDescriptions: ips.map((Id) => ({ Target: { Id }, TargetHealth: { State: "healthy" } })) });
  }
  default: process.stderr.write("fake aws: unhandled " + args.join(" ") + "\n"); process.exit(2);
}
`;

// The script needs jq; a runner without it skips these rather than block main's CI (the deploy job installs it).
const skip = spawnSync("jq", ["--version"]).status === 0 ? false : "jq is not installed";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// Commits A < B < C on one line, plus D on a branch off A.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "ecs-deploy-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  const commit = (name: string) => { git(repo, "commit", "-q", "--allow-empty", "-m", name); return git(repo, "rev-parse", "HEAD"); };
  const a = commit("A"), b = commit("B"), c = commit("C");
  git(repo, "checkout", "-q", "-b", "side", a);
  const d = commit("D");
  mkdirSync(join(root, "infra"));
  for (const file of ["ecs-deploy.sh", "config.sh"]) copyFileSync(new URL(file, infra), join(root, "infra", file));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "aws"), fakeAws);
  writeFileSync(join(root, "bin", "curl"), "#!/bin/sh\necho ok\n");
  writeFileSync(join(root, "bin", "sleep"), "#!/bin/sh\n");
  for (const bin of ["aws", "curl", "sleep"]) chmodSync(join(root, "bin", bin), 0o755);
  return { root, repo, sha: { a, b, c, d }, tag: (s: string) => s.slice(0, 12) };
}

// `at: "completed"`: at the first describe-services after the rollout was seen COMPLETED (the check after the smoke).
type Plan = { at: number | "register" | "completed"; tag?: string; revision?: number }[];
function deploy(env: ReturnType<typeof setup>, live: string, target: string, options: { plan?: Plan; allowOlder?: boolean; taskImageOverride?: string; liveRevisions?: string[]; primaryRevision?: number; failAt?: number; apiErrorAt?: number } = {}) {
  const revisions = (options.liveRevisions ?? [live]).map((s) => `${registry}:${env.tag(s)}`);
  const state = {
    images: Object.values(env.sha).map(env.tag), revisions, tick: 0, failAt: options.failAt, apiErrorAt: options.apiErrorAt, completedSeen: false, completeAfter: 4, deploymentCount: 1, calls: [] as string[],
    plan: (options.plan ?? []).map((s) => ({ ...s, tag: s.tag && env.tag(s.tag) })),
    taskImageOverride: options.taskImageOverride && `${registry}:${env.tag(options.taskImageOverride)}`,
    service: { deployments: [{ id: "ecs-svc/1", status: "PRIMARY", taskDefinition: `arn:aws:ecs:us-west-2:1:task-definition/camelai-agent-runtime:${options.primaryRevision ?? revisions.length}`, rolloutState: "COMPLETED", started: -1 }], events: [{ id: "ev0", message: "(service camelai-agent-runtime) has reached a steady state." }] },
  };
  const stateFile = join(env.root, "state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const result = spawnSync("bash", [join(env.root, "infra", "ecs-deploy.sh"), env.tag(target)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(env.root, "bin")}:${process.env.PATH}`, FAKE_ECS_STATE: stateFile, DEPLOY_SHA: target,
      DEPLOY_GIT_DIR: env.repo, DEPLOY_POLL_SECONDS: "0", DEPLOY_ALLOW_OLDER: options.allowOlder ? "1" : "", GITHUB_STEP_SUMMARY: "" },
  });
  const after = JSON.parse(readFileSync(stateFile, "utf8"));
  const updates = (after.calls as string[]).filter((c) => c.startsWith("ecs update-service")).map((c) => after.revisions[Number(c.split(":").pop()) - 1].split(":").pop());
  return { status: result.status, output: result.stdout + result.stderr, updates, registered: after.revisions.length - revisions.length - (options.plan ?? []).filter((s) => s.tag).length };
}

test("deploys exactly its own commit's image over an older one, and verifies the running tasks", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.a, env.sha.b);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.updates, [env.tag(env.sha.b)]);
  assert.match(run.output, /running image verified: 3\/3 tasks on .*:[0-9a-f]{12} \(sha256:/);
  assert.match(run.output, /ecs: has started 3 tasks/);
});

test("never rolls an older commit over a newer one: it follows the newer deployment instead", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.c, env.sha.b);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.updates, []);
  assert.equal(run.registered, 0);
  assert.match(run.output, /includes .* following it instead of deploying an older commit/);
});

test("a rollback on purpose deploys the older commit", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.c, env.sha.b, { allowOlder: true });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.updates, [env.tag(env.sha.b)]);
});

test("a commit neither older nor newer than production's is refused without a rollback", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.c, env.sha.d);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /neither older nor newer/);
  assert.deepEqual(run.updates, []);
});

test("the image production already runs is followed, not redeployed; with newer settings it is redeployed", { skip }, () => {
  const env = setup();
  const same = deploy(env, env.sha.b, env.sha.b);
  assert.equal(same.status, 0, same.output);
  assert.deepEqual(same.updates, []);
  assert.match(same.output, /already runs/);
  // Terraform registered a revision with new settings after the running one: redeploying the running image ships it.
  const settings = deploy(env, env.sha.b, env.sha.b, { liveRevisions: [env.sha.b, env.sha.b], primaryRevision: 1 });
  assert.equal(settings.status, 0, settings.output);
  assert.deepEqual(settings.updates, [env.tag(env.sha.b)]);
});

test("a newer deployment that replaces this one mid-rollout is followed to completion", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.a, env.sha.b, { plan: [{ at: 3, tag: env.sha.c }] });
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /superseded: .* includes/);
  assert.match(run.output, new RegExp(`running image verified: 3/3 tasks on .*:${env.tag(env.sha.c)}`));
});

test("a rollback or an older deployment replacing this one fails the deploy", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.a, env.sha.c, { plan: [{ at: 3, revision: 1 }] });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /rolled back .* or replaced by a deployment without/);
});

test("a deploy that started while this one registered is decided again before the update", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.a, env.sha.b, { plan: [{ at: "register", tag: env.sha.c }] });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.updates, []);
  assert.match(run.output, /not using .*camelai-agent-runtime:\d+/);
  assert.match(run.output, new RegExp(`running image verified: 3/3 tasks on .*:${env.tag(env.sha.c)}`));
});

test("a running task on another image fails the deploy", { skip }, () => {
  const env = setup();
  const run = deploy(env, env.sha.a, env.sha.b, { taskImageOverride: env.sha.a });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /running tasks not on/);
});

test("a rollback after the new tasks are healthy, or during the public smoke, fails the deploy", () => {
  const env = setup();
  const after = deploy(env, env.sha.a, env.sha.b, { plan: [{ at: 4, revision: 1 }] });
  assert.equal(after.status, 1, after.output);
  assert.match(after.output, /new tasks healthy: 3\/3/);
  assert.match(after.output, /rolled back/);
  assert.doesNotMatch(after.output, /deployed:/);
  const smoke = deploy(env, env.sha.a, env.sha.b, { plan: [{ at: "completed", revision: 1 }] });
  assert.equal(smoke.status, 1, smoke.output);
  assert.match(smoke.output, /rollout COMPLETED[\s\S]*rolled back/);
  assert.doesNotMatch(smoke.output, /deployed:/);
  assert.deepEqual([after.updates, smoke.updates], [[env.tag(env.sha.b)], [env.tag(env.sha.b)]]);
});

test("a failed rollout or an ECS API error fails the deploy without another update", () => {
  const env = setup();
  for (const options of [{ failAt: 3 }, { apiErrorAt: 3 }]) {
    const run = deploy(env, env.sha.a, env.sha.b, options);
    assert.equal(run.status === 0, false, run.output);
    assert.doesNotMatch(run.output, /deployed:/);
    assert.deepEqual(run.updates, [env.tag(env.sha.b)]);
  }
});
