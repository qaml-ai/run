import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { errorClass, safeError } from "../src/metrics.ts";
import { HttpError } from "../src/http.ts";

/**
 * Logs keep ids and sizes, never what a user wrote: prompts, transcripts, tool arguments and results, files, email.
 * This scans every log call in src/ and shared/ (console.*, stdout/stderr writes, and the metric and diagnostic
 * helpers that end in one) for fields that would carry such text, and for raw error messages, which can echo it.
 */
const CALLS = /(?:console\.(?:log|error|warn|info|debug)|process\.std(?:out|err)\.write|(?<![\w.$]|function |async )(?:log|emit|sink|metricLine|diagnostic))\(/g;

/** Keys whose value is user content. */
const FORBIDDEN = new Set(["text", "prompt", "content", "message", "messages", "arguments", "args", "input", "output", "result", "results",
  "body", "subject", "from", "to", "cc", "email", "address", "recipient", "path", "file", "filename", "code", "query", "url", "reply", "answer", "html", "data",
  // Credentials: an agent's token (as GET /v1/agents/{id}/credentials gives it), API and browser tokens, keys, secrets.
  "token", "apiKey", "secret", "authorization", "password",
  // A mailed link carries a sign-up or reset token.
  "link"]);

/** Forbidden keys that are safe where they are, by file. */
const ALLOWED_KEYS: Record<string, string[]> = {
  "src/server.ts": ["address"], // The listening line: the server's own listen address.
  "src/auto-topup.ts": ["code"], // Stripe's error code, an identifier.
  "src/channels-discord.ts": ["code"], // The gateway WebSocket's close code, a number.
  // The `log` account mail provider writes each link and its address for the operator to pass on: only where no one
  // else may sign up (accountMailConfig refuses it with open sign-up on a public URL).
  "src/account-mail.ts": ["to", "link"],
};

/**
 * Lines that log an error's own message (`errorText`, `.message`, `String(error)`): only system work, whose errors are
 * the database's, storage's, AWS's or the runtime's own, with nothing a user wrote. Anything touching model responses,
 * tool calls, channels or requests logs `safeError(error)` instead.
 */
const RAW_ERRORS = new Set([
  // Database, migrations and node coordination.
  "database_connection_error", "database_credentials_refresh_failed", "database_listen_failed", "migration_lock_timeout",
  "heartbeat_renew_failed", "fence_listener_failed", "tenants_reload_failed", "idempotency_expiry_failed",
  // ECS, retirement and drains.
  "task_protection_failed", "ecs_service_unavailable", "ecs_service_check_failed", "retire_release_failed", "retire_pause_failed", "drain_step_failed",
  // Background sweeps and outboxes, over their own tables.
  "scheduler_scan_failed", "channel_scan_failed", "channel_gateways_failed", "webhook_scan_failed", "webhook_backlog_failed", "orphan_sweep_failed",
  "tail_sweep_failed", "usage_flush_failed", "storage_usage_flush_failed", "storage_charge_failed", "storage_gc_failed", "input_expiry_failed",
  "agent_purge_failed", "agent_purge_sweep_failed", "agent_discard_failed", "agent_volumes_release_failed", "agent_spend_write_failed",
  "active_report_failed", "history_index_failed",
  // The help form's own bookkeeping; the request's text is never in these errors.
  "help_state_failed", "help_suppress_failed", "help_context_failed",
]);
const RAW = /errorText\(|\.message\b|String\(\(?error\b/;

/** From just past `(`, the text up to its matching `)`, skipping strings. */
function argumentsAt(source: string, start: number) {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "\"" || char === "'" || char === "`") {
      for (i++; i < source.length && source[i] !== char; i++) if (source[i] === "\\") i++;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

/** Every problem in `source`'s log calls, as "file:line: why". */
function logProblems(file: string, source: string) {
  const problems: string[] = [];
  for (const call of source.matchAll(CALLS)) {
    const args = argumentsAt(source, call.index + call[0].length);
    const where = `${file}:${source.slice(0, call.index).split("\n").length}`;
    // Keys written `key: value`, and shorthand `{ key }`; spreads are checked where their fields are made.
    const keys = [...args.matchAll(/[{,]\s*(\w+)\s*(?::|(?=[,}]))/g)].map(match => match[1]);
    for (const key of keys) if (FORBIDDEN.has(key) && !ALLOWED_KEYS[file]?.includes(key)) problems.push(`${where}: logs \`${key}\``);
    if (RAW.test(args)) {
      const type = /type: "(\w+)"/.exec(args)?.[1];
      if (!type || !RAW_ERRORS.has(type)) problems.push(`${where}: logs an error's message (${type ?? "no type"}); use safeError(error)`);
    }
  }
  return problems;
}

const sources = ["src", "shared"].flatMap(dir => readdirSync(dir).filter(name => name.endsWith(".ts")).map(name => `${dir}/${name}`));

test("no log line carries user content or a raw error message", () => {
  const problems = sources.flatMap(file => logProblems(file, readFileSync(file, "utf8")));
  assert.deepEqual(problems, []);
});

test("the scan catches content fields and raw errors in new log lines", () => {
  const bad = [
    `console.log(JSON.stringify({ type: "prompt_received", agent: id, text: params.text }));`,
    `console.error(JSON.stringify({ type: "tool_call_failed", agent, args }));`,
    `console.error(JSON.stringify({ type: "send_failed", error: errorText(error) }));`,
    `console.error(JSON.stringify({ type: "send_failed", error: (error as Error).message }));`,
    `emit("model_error", { dimensions: {}, rollups: [], metrics: {}, properties: { subject: mail.subject } });`,
    `console.log(JSON.stringify({ type: "agent_credentials", agent: id, token: credentials.token }));`,
  ];
  for (const line of bad) assert.equal(logProblems("src/example.ts", line).length, 1, line);
  const good = `console.error(JSON.stringify({ type: "send_failed", item: item.id, bytes: body.length, messageId, error: safeError(error) }));`;
  assert.deepEqual(logProblems("src/example.ts", good), []);
});

test("safeError keeps an error's class, name, status and code, and only the length of its message", () => {
  const prompt = "429 Too Many Requests: please summarize my secret merger memo";
  assert.equal(safeError(new Error(prompt)), `rate_limit Error (${prompt.length} chars)`);
  assert.equal(safeError(new HttpError(409, "Key belongs to someone@example.com", "CONFLICT")), "other HttpError 409 CONFLICT (34 chars)");
  assert.equal(safeError(Object.assign(new Error("x"), { code: "a code with spaces and someone@example.com" })), "other Error (1 chars)");
  assert.equal(safeError("overloaded"), "overloaded (10 chars)");
  assert.equal(safeError(undefined), `${errorClass("undefined")} (9 chars)`);
});

test("an agent process's stderr reaches the log only through childStderr, which keeps its own lines and reduces anything else to its name, class, place and size", async () => {
  // Every process the runtime spawns has its stderr piped, not inherited, and filtered.
  const rpc = readFileSync("src/rpc.ts", "utf8");
  assert.match(rpc, /stdio: \["ignore", "ignore", "pipe", "ipc"\]/);
  assert.match(rpc, /childStderr\(/);
  for (const file of sources) assert.doesNotMatch(readFileSync(file, "utf8"), /stdio:[^\n]*"inherit"/, `${file} lets a child's output into the log unfiltered`);

  const { childStderr } = await import("../src/child-stderr.ts");
  const lines: string[] = [];
  const stderr = childStderr("client_x", line => lines.push(line));
  const own = JSON.stringify({ type: "turn_metrics", agent: "client_x", Turns: 1 });
  stderr.data(`${own}\nfile:///app/src/agent-host.ts:120\n  throw new TypeError(\`Cannot read "launch code 4321" of undefined\`);\n`);
  stderr.data("TypeError: Cannot read properties of undefined (reading 'the secret plan for ada@example.com')\n    at render (file:///app/src/agent-host.ts:120:9)\n");
  stderr.data("    at next (file:///app/node_modules/@earendil-works/pi-agent-core/dist/agent.js:88:3)\n(node:12) ExperimentalWarning: prompt text here\n{\"not\": \"ours\", \"content\": \"private\"}\npartial line with no end");
  stderr.end();
  const text = lines.join("");
  for (const secret of ["4321", "secret plan", "ada@example.com", "prompt text", "private", "partial line"]) assert.ok(!text.includes(secret), `${secret} reached the log`);
  assert.equal(lines[0], `${own}\n`, "the process's own lines pass as they are");
  const reduced = lines.slice(1).map(line => JSON.parse(line));
  assert.ok(reduced.every(line => line.type === "agent_stderr" && line.agent === "client_x"));
  const crash = reduced.find(line => line.name === "TypeError" && line.lines === 3);
  assert.deepEqual(crash && { at: crash.at, class: typeof crash.class, bytes: crash.bytes > 0 }, { at: "src/agent-host.ts:120", class: "string", bytes: true });
  assert.ok(reduced.some(line => line.name === "ExperimentalWarning"));
});
