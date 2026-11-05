import ts from "typescript";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("../", import.meta.url)),
  root = path.resolve(here, "../..");
// These suites exercise the public platform APIs through the same runtime()
// fixture as the API/SDK suites. Direct Node service tests below stay excluded.
const platformFiles = new Set(["projects.test.ts", "files.test.ts"]);
const candidates = (await readdir(path.join(root, "tests")))
  .filter((f) => /(api|sdk).*\.test\.ts$/.test(f) || platformFiles.has(f))
  .sort();
const only = process.env.COMPAT_ONLY?.split(",");
const runSet = new Set([
  "cli-api.test.ts",
  "sdk-portable.test.ts",
  "sdk-lazy-connections.test.ts",
  "sdk-multi-agent.test.ts",
  "sdk-server.test.ts",
  "computers-api.test.ts",
  "decisions-api.test.ts",
  "openapi-sources.test.ts",
  "image-generation-api.test.ts",
  "image-generation-sdk.test.ts",
  "transcription-api.test.ts",
  "transcription-sdk.test.ts",
  "ui-ai-sdk.test.ts",
  "schedule-api.test.ts",
  ...platformFiles,
]);
const caseExclusions = {
  "schedule-api.test.ts": new Map([
    [
      "public accounts can email their verified address and cannot email strangers or suppressed recipients",
      "Constructs Node Accounts and Tenants services directly; cannot target a base URL unchanged",
    ],
    [
      "a calendar wake-up tells the model its fixed local edition date",
      "Mutates the Node Postgres schedule table to trigger its scheduler; Workers schedules live in DO SQLite",
    ],
  ]),
  "files.test.ts": new Map([
    [
      "an upload streams to storage a chunk at a time: the source is never more than a few chunks ahead of storage",
      "Includes direct Node VolumeService/storage instrumentation; cannot target a base URL unchanged",
    ],
  ]),
};
const rows = [];
for (const file of candidates) {
  if (only && !only.includes(file)) continue;
  const text = await readFile(path.join(root, "tests", file), "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = [];
  const kinds = new Map();
  const evaluate = (node, env) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) return env[node.text];
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((x) => evaluate(x, env));
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map(
            (x) =>
              String(evaluate(x.expression, env) ?? "{dynamic}") +
              x.literal.text,
          )
          .join("")
      );
  };
  const scan = (node, env = {}) => {
    if (ts.isForOfStatement(node)) {
      const variable = node.initializer.declarations?.[0]?.name?.text,
        values = evaluate(node.expression, env);
      if (variable && Array.isArray(values)) {
        for (const value of values)
          scan(node.statement, { ...env, [variable]: value });
        return;
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "test") {
      const name =
        evaluate(node.arguments[0], env) ?? node.arguments[0].getText(ast);
      names.push(name);
      kinds.set(
        name,
        /\bruntime\s*\(/.test(node.getText(ast)) ? "worker" : "sdk-unit",
      );
      return;
    }
    ts.forEachChild(node, (child) => scan(child, env));
  };
  scan(ast);
  // Do not count original Node-only file unit tests as evidence for Workers.
  // The remaining cases still run every original assertion unchanged.
  const excluded = new Map(caseExclusions[file]);
  if (platformFiles.has(file)) {
    for (const name of names) if (kinds.get(name) !== "worker")
      excluded.set(name, "Direct Node service/unit test; cannot target a base URL unchanged");
  }
  let reason;
  if (/^voice/.test(file))
    reason = "Voice sessions excluded by requested scope";
  else if (!runSet.has(file))
    reason = /openapi\.test/.test(file)
      ? "Source-generated Node API schema test; does not accept a base URL"
      : "Fixture directly constructs Node runtime or services; cannot target a base URL unchanged";
  if (reason) {
    rows.push(
      ...names.map((test) => ({
        file: `tests/${file}`,
        test,
        status: "not-applicable",
        reason,
      })),
    );
    continue;
  }
  const log = [];
  const eligible = names.filter((name) => !excluded.has(name));
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const args = [
    "--import",
    path.join(here, "test/compat-register.mjs"),
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "--test",
    "--test-reporter=tap",
    "--test-timeout=45000",
    ...(eligible.length === names.length
      ? []
      : ["--test-name-pattern", `^(?:${eligible.map(escape).join("|")})$`]),
    path.join(root, "tests", file),
  ];
  let result;
  let reused;
  if (process.env.COMPAT_REUSE_RESULTS === "1") {
    try {
      reused = await readFile(
        path.join(here, "measurements", `compat-${file}.tap`),
        "utf8",
      );
      result = { reused: true };
    } catch {}
  }
  if (reused === undefined)
    result = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: here,
        env: {
          ...process.env,
          AGENT_TEST_DATABASE_URL:
            process.env.AGENT_TEST_DATABASE_URL ??
            "postgresql://postgres:local-only-unused@127.0.0.1:55434/camelrun_proto",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (x) => log.push(x.toString()));
      child.stderr.on("data", (x) => log.push(x.toString()));
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
  const output = (reused ?? log.join("")).replace(/[ \t]+$/gm, "");
  await writeFile(
    path.join(here, "measurements", `compat-${file}.tap`),
    output,
  );
  for (const test of names) {
    if (excluded.has(test)) {
      rows.push({
        file: `tests/${file}`,
        test,
        status: "not-applicable",
        reason: excluded.get(test),
      });
      continue;
    }
    const escaped = test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `^(not ok|ok) \\d+ - ${escaped}(?:\\n| \\#)`,
      "m",
    ).exec(output);
    rows.push({
      file: `tests/${file}`,
      test,
      status: match?.[1] === "ok" ? "pass" : "fail",
      kind: [
        "image-generation-api.test.ts",
        "image-generation-sdk.test.ts",
        "transcription-api.test.ts",
        "transcription-sdk.test.ts",
        "ui-ai-sdk.test.ts",
      ].includes(file)
        ? "worker"
        : kinds.get(test),
      reason: match
        ? "Original assertion result"
        : "Test did not finish; see TAP log",
      process: result,
    });
  }
  console.log(
    `${file}: ${rows.filter((x) => x.file === `tests/${file}` && x.status === "pass").length}/${eligible.length} eligible passed`,
  );
}
if (only) {
  try {
    const previous = JSON.parse(
      await readFile(
        path.join(here, "measurements/compatibility.json"),
        "utf8",
      ),
    ).rows;
    rows.push(
      ...previous.filter(
        (r) =>
          r.file !== "tests/python_sdk.py" &&
          !only.includes(r.file.replace("tests/", "")),
      ),
    );
  } catch {}
}
try {
  const python = JSON.parse(
    await readFile(path.join(here, "measurements/python-compat.json"), "utf8"),
  );
  rows.push(...python.map((r) => ({ file: "tests/python_sdk.py", ...r })));
} catch {}
await writeFile(
  path.join(here, "measurements/compatibility.json"),
  JSON.stringify(
    {
      method:
        "Original test assertions; Node server fixture replaced with local Workers and original fake model. Unit-only results separated. N/A never counted as pass.",
      rows,
    },
    null,
    2,
  ) + "\n",
);
const count = (status) => rows.filter((x) => x.status === status).length;
console.log(
  JSON.stringify({
    pass: count("pass"),
    fail: count("fail"),
    notApplicable: count("not-applicable"),
    workerPass: rows.filter((x) => x.status === "pass" && x.kind === "worker")
      .length,
  }),
);

// Inventory is complete, but a failing contract is still a failing check.
process.exitCode = rows.some((row) => row.status === "fail") ? 1 : 0;
