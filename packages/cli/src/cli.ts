import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Api, enc } from "./api.ts";
import { DEFAULT_URL, forget, resolve, save } from "./config.ts";
import { DEFAULT_FILES, findManifest, loadManifests, template } from "./manifest.ts";
import * as ops from "./ops.ts";
import { VERSION } from "./version.ts";


const HELP = `camelrun: deploy and manage agents on Camel Run, the camelAI agent runtime

Usage: camelrun <command> [options]

Setup
  login [--api-key art_…]          Save an API key (checked against the runtime)
  logout                           Forget the saved key
  whoami                           The tenant the key belongs to, and its default model
  models [--available]             Models, or only those your account can use
  init [key] [--model m]           Write an agent.yaml manifest here

Deploy
  deploy [file…] [--apply] [--dry-run]
                                   Upsert each manifest's definition by its key and make its agents;
                                   --apply also moves live agents to the new revision between turns

Agents (an agent is its key or its id, client_…)
  agents list
  agents get <agent>               Configuration, definition revision and tool sources
  agents create <key> [--definition key|id] [--model m] [--prompt text] [--name n]
  agents configure <agent> [--model m] [--prompt text] [--prompt-append text] [--thinking level]
  agents delete <agent> --yes      Stop it and purge its history and files
  run <agent> <message…> [--wait s] [--no-wait] [--from user] [--steer] [--allow-disconnected]
  runs get <agent> <requestId> [--wait s]
  history <agent> [--limit n]
  abort <agent>
  inputs [agent]                   Questions and approvals waiting on someone
  answer <agent> <inputId> <value> true/false, text, JSON, or "decline"
  schedules list <agent>
  schedules add <agent> --text t (--in s | --at iso) [--every s]
  schedules delete <agent> <scheduleId>

Definitions (a definition is its key or its id, def_…)
  definitions list
  definitions get <definition>
  definitions agents <definition>  Its agents and the revision each has
  definitions delete <definition> --yes

MCP
  mcp                              Serve these commands as an MCP server over stdio
                                   (or connect clients to the hosted one: https://agents.camelai.dev/mcp)

Options
  --json                           Print JSON (the default when stdout is not a terminal)
  --api-key <key>, --url <url>     Instead of CAMELAI_API_KEY / CAMELAI_URL / the saved login

Docs: https://agents.camelai.dev/llms.txt`;

const OPTIONS = {
  json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  "api-key": { type: "string" }, url: { type: "string" },
  apply: { type: "boolean" }, "dry-run": { type: "boolean" }, available: { type: "boolean" }, force: { type: "boolean" }, yes: { type: "boolean", short: "y" },
  model: { type: "string" }, prompt: { type: "string" }, "prompt-append": { type: "string" }, thinking: { type: "string" }, name: { type: "string" }, definition: { type: "string" },
  wait: { type: "string" }, "no-wait": { type: "boolean" }, from: { type: "string" }, steer: { type: "boolean" }, "allow-disconnected": { type: "boolean" }, "request-id": { type: "string" },
  limit: { type: "string" }, text: { type: "string" }, in: { type: "string" }, at: { type: "string" }, every: { type: "string" },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export interface Io { out: (text: string) => void; err: (text: string) => void; tty: boolean; env: NodeJS.ProcessEnv; cwd: string }

class UsageError extends Error {}

/** Run the CLI; resolves with its exit code: 0, 1 for an error, 2 when a run waits on a person. */
export async function main(argv: string[], io: Io = { out: text => process.stdout.write(text + "\n"), err: text => process.stderr.write(text + "\n"), tty: !!process.stdout.isTTY, env: process.env, cwd: process.cwd() }): Promise<number> {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (error) { io.err(`${(error as Error).message}\n\nRun camelrun --help for usage.`); return 1; }
  const { values: flags, positionals } = parsed;
  if (flags.version) { io.out(VERSION); return 0; }
  const [command, ...args] = positionals;
  if (!command || flags.help || command === "help") { io.out(HELP); return 0; }
  const json = flags.json || !io.tty;
  const print = (value: unknown, human?: () => string) => io.out(json || !human ? JSON.stringify(value, null, 2) : human());
  const api = () => new Api(resolve({ apiKey: flags["api-key"], url: flags.url }, io.env));
  try {
    switch (command) {
      case "mcp": {
        const { serve } = await import("./mcp.ts");
        await serve(() => api(), { cwd: io.cwd });
        return 0;
      }
      case "login": return await login(flags, io, print);
      case "logout": {
        const path = forget(io.env);
        print({ loggedOut: !!path }, () => path ? `Removed ${path}` : "No saved key");
        return 0;
      }
      case "whoami": {
        const client = api();
        const me = await client.me();
        print({ ...me, url: client.url }, () => `${me.login ?? me.tenant} (tenant ${me.tenant}) on ${client.url}\nDefault model: ${me.defaultModel}`);
        return 0;
      }
      case "models": {
        const models: any[] = await api().get(`/v1/models${flags.available ? "?available=true" : ""}`);
        print(models.map(({ id, name, available, contextWindow, reasoning, cost }) => ({ id, name, available, contextWindow, reasoning, cost })),
          () => table(models, ["id", "available", "contextWindow", "reasoning"]));
        return 0;
      }
      case "init": {
        const key = args[0] ?? io.cwd.split("/").pop()!.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
        const path = `${io.cwd}/agent.yaml`;
        if (DEFAULT_FILES.some(name => existsSync(`${io.cwd}/${name}`)) && !flags.force) throw new UsageError("A manifest is already here (--force overwrites agent.yaml)");
        writeFileSync(path, template(key, flags.model));
        print({ file: path, key }, () => `Wrote ${path}. Edit it, then: camelrun deploy`);
        return 0;
      }
      case "deploy": {
        const files = args.length ? args : [findManifest(io.cwd)];
        const manifests = files.flatMap(file => loadManifests(file.startsWith("/") ? file : `${io.cwd}/${file}`, io.env));
        const results = await ops.deploy(api(), manifests, { apply: flags.apply, dryRun: flags["dry-run"] });
        if (flags["dry-run"] && json) print(results.map((result, index) => ({ ...result, definition: ops.redact(manifests[index].definition) })));
        else print(results, () => results.map(describeDeploy).join("\n"));
        return results.some(result => result.agents.some(agent => agent.status === "failed") || result.applied?.some(applied => applied.status === "failed")) ? 1 : 0;
      }
      case "agents": return await agents(args, flags, api, print);
      case "definitions": return await definitions(args, flags, api, print);
      case "run": {
        const [agent, ...words] = args;
        if (!agent || !words.length) throw new UsageError("Usage: camelrun run <agent> <message…>");
        const result = await ops.run(api(), agent, words.join(" "), { wait: waitSeconds(flags), from: flags.from, steer: flags.steer, allowDisconnected: flags["allow-disconnected"], requestId: flags["request-id"] });
        return printRun(result, print, io);
      }
      case "runs": {
        const [sub, agent, requestId] = args;
        if (sub !== "get" || !agent || !requestId) throw new UsageError("Usage: camelrun runs get <agent> <requestId> [--wait s]");
        const client = api();
        return printRun(await ops.waitFor(client, await client.agentId(agent), requestId, flags.wait ? Number(flags.wait) : 0), print, io);
      }
      case "history": {
        if (!args[0]) throw new UsageError("Usage: camelrun history <agent> [--limit n]");
        const page = await ops.history(api(), args[0], flags.limit ? Number(flags.limit) : 20);
        print(page, () => page.messages.map((message: any) => {
          const head = message.role === "toolResult" ? `[${message.tool} →]` : `${message.role}${"from" in message ? ` (${message.from})` : ""}:`;
          const calls = "toolCalls" in message ? (message.toolCalls as any[]).map(call => `\n  → ${call.name}(${JSON.stringify(call.arguments).slice(0, 200)})`).join("") : "";
          return `${head} ${message.text ?? ""}${calls}`;
        }).join("\n\n") || "(no messages)");
        return 0;
      }
      case "abort": {
        if (!args[0]) throw new UsageError("Usage: camelrun abort <agent>");
        const client = api();
        const id = await client.agentId(args[0]);
        print(await client.call("POST", `/v1/agents/${enc(id)}/abort`, {}), () => `Aborted the running turn of ${args[0]}`);
        return 0;
      }
      case "inputs": {
        const client = api();
        const inputs: any[] = args[0] ? await client.get(`/v1/agents/${enc(await client.agentId(args[0]))}/inputs?state=pending`) : await client.get("/v1/inputs?state=pending");
        print(inputs, () => inputs.length ? inputs.map(input => `${input.id}  ${input.agent}  ${input.kind}: ${input.message ?? JSON.stringify(input.detail).slice(0, 200)}`).join("\n") : "Nothing is waiting");
        return 0;
      }
      case "answer": {
        const [agent, inputId, ...rest] = args;
        if (!agent || !inputId || !rest.length) throw new UsageError("Usage: camelrun answer <agent> <inputId> <value>");
        const raw = rest.join(" ");
        let value: unknown = raw;
        try { value = JSON.parse(raw); } catch { /* text */ }
        const result = await ops.answer(api(), agent, inputId, value, { from: flags.from, wait: waitSeconds(flags) });
        return "requestId" in result ? printRun(result, print, io) : (print(result, () => result.note), 0);
      }
      case "schedules": return await schedules(args, flags, api, print);
      default: throw new UsageError(`Unknown command: ${command}. Run camelrun --help`);
    }
  } catch (error) {
    io.err(json && !(error instanceof UsageError) ? JSON.stringify({ error: (error as Error).message, ...("status" in (error as object) ? { status: (error as any).status, code: (error as any).code } : {}) }) : `Error: ${(error as Error).message}`);
    return 1;
  }
}

async function login(flags: Flags, io: Io, print: (value: unknown, human?: () => string) => void) {
  let apiKey = flags["api-key"] || io.env.CAMELAI_API_KEY;
  if (!apiKey) {
    if (!process.stdin.isTTY) throw new UsageError("Pass --api-key art_… (or set CAMELAI_API_KEY); create one under API tokens at https://agents.camelai.dev/console");
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    apiKey = (await prompt.question("API key (from https://agents.camelai.dev/console, API tokens): ")).trim();
    prompt.close();
  }
  const url = flags.url || io.env.CAMELAI_URL || DEFAULT_URL;
  const me = await new Api({ apiKey, url }).me();
  const path = save({ apiKey, url }, io.env);
  print({ tenant: me.tenant, url, saved: path }, () => `Logged in as ${me.login ?? me.tenant} on ${url} (key saved to ${path})`);
  return 0;
}

async function agents(args: string[], flags: Flags, api: () => Api, print: (value: unknown, human?: () => string) => void) {
  const [sub, target] = args;
  const client = api();
  switch (sub) {
    case "list": case undefined: {
      const list: any[] = await client.get("/v1/agents");
      print(list, () => list.length ? table(list, ["key", "id", "model", "running", "connected"]) : "No agents yet: camelrun deploy, or camelrun agents create <key>");
      return 0;
    }
    case "get": {
      if (!target) throw new UsageError("Usage: camelrun agents get <agent>");
      const detail = await client.get(`/v1/agents/${enc(await client.agentId(target))}`);
      print(detail);
      return 0;
    }
    case "create": {
      if (!target) throw new UsageError("Usage: camelrun agents create <key> [--definition d] [--model m] [--prompt text]");
      const created = await ops.upsertAgent(client, target, { definition: flags.definition, model: flags.model, systemPrompt: flags.prompt, systemPromptAppend: flags["prompt-append"], name: flags.name });
      print(created, () => `${created.key}: ${created.id}${created.reconfigured ? " (reconfigured)" : ""}`);
      return 0;
    }
    case "configure": {
      if (!target) throw new UsageError("Usage: camelrun agents configure <agent> [--model m] [--prompt text] [--prompt-append text] [--thinking level]");
      const changes = Object.fromEntries(Object.entries({ model: flags.model, systemPrompt: flags.prompt, systemPromptAppend: flags["prompt-append"], thinkingLevel: flags.thinking }).filter(([, value]) => value !== undefined));
      if (!Object.keys(changes).length) throw new UsageError("Nothing to change: pass --model, --prompt, --prompt-append or --thinking");
      const result = await ops.configure(client, target, changes);
      print(result, () => result.status === "failed" ? `Failed: ${result.error?.message}` : result.status === "running" ? `Queued behind its current run (request ${result.requestId})` : `Configured ${target}`);
      return result.status === "failed" ? 1 : 0;
    }
    case "delete": {
      if (!target) throw new UsageError("Usage: camelrun agents delete <agent> --yes");
      if (!flags.yes) throw new UsageError(`Deleting ${target} stops it and purges its history and files. Pass --yes to go ahead.`);
      const id = await client.agentId(target);
      print(await client.call("DELETE", `/v1/agents/${enc(id)}`), () => `Deleted ${target} (${id})`);
      return 0;
    }
    default: throw new UsageError(`Unknown: agents ${sub}. Run camelrun --help`);
  }
}

async function definitions(args: string[], flags: Flags, api: () => Api, print: (value: unknown, human?: () => string) => void) {
  const [sub, target] = args;
  const client = api();
  switch (sub) {
    case "list": case undefined: {
      const list: any[] = await client.get("/v1/definitions");
      print(list, () => list.length ? table(list, ["id", "name", "revision", "model"]) : "No definitions yet: camelrun init, then camelrun deploy");
      return 0;
    }
    case "get": case "agents": case "delete": {
      if (!target) throw new UsageError(`Usage: camelrun definitions ${sub} <definition>`);
      const id = await client.definitionId(target);
      if (sub === "get") print(await client.get(`/v1/definitions/${id}`));
      else if (sub === "agents") {
        const list: any[] = await client.get(`/v1/definitions/${id}/agents`);
        print(list, () => list.length ? table(list, Object.keys(list[0]).slice(0, 5)) : "No agents");
      } else {
        if (!flags.yes) throw new UsageError(`Pass --yes to delete ${target}; its agents are left as they are`);
        print(await client.call("DELETE", `/v1/definitions/${id}`), () => `Deleted ${target} (${id})`);
      }
      return 0;
    }
    default: throw new UsageError(`Unknown: definitions ${sub}. Run camelrun --help`);
  }
}

async function schedules(args: string[], flags: Flags, api: () => Api, print: (value: unknown, human?: () => string) => void) {
  const [sub, agent, scheduleId] = args;
  if (!agent) throw new UsageError("Usage: camelrun schedules list|add|delete <agent> …");
  const client = api();
  const id = await client.agentId(agent);
  switch (sub) {
    case "list": {
      const list: any[] = await client.get(`/v1/agents/${enc(id)}/schedules`);
      print(list, () => list.length ? list.map(item => `${item.id}  ${new Date(item.dueAt).toISOString()}${item.everySeconds ? ` every ${item.everySeconds}s` : ""}  ${item.text ?? item.code}`).join("\n") : "No schedules");
      return 0;
    }
    case "add": {
      if (!flags.text || (!flags.in && !flags.at)) throw new UsageError("Usage: camelrun schedules add <agent> --text t (--in seconds | --at iso) [--every seconds]");
      const body = { text: flags.text, ...(flags.in ? { inSeconds: Number(flags.in) } : { at: flags.at }), ...(flags.every ? { everySeconds: Number(flags.every) } : {}) };
      const created = await client.call("POST", `/v1/agents/${enc(id)}/schedules`, body);
      print(created, () => `${created.id}: due ${new Date(created.dueAt).toISOString()}`);
      return 0;
    }
    case "delete": {
      if (!scheduleId) throw new UsageError("Usage: camelrun schedules delete <agent> <scheduleId>");
      print(await client.call("DELETE", `/v1/agents/${enc(id)}/schedules/${enc(scheduleId)}`), () => `Deleted ${scheduleId}`);
      return 0;
    }
    default: throw new UsageError(`Unknown: schedules ${sub}. Run camelrun --help`);
  }
}

function waitSeconds(flags: Flags) {
  if (flags["no-wait"]) return 0;
  if (flags.wait === undefined) return undefined;
  const seconds = Number(flags.wait);
  if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError("--wait is a number of seconds");
  return seconds;
}

function printRun(result: ops.RunSummary, print: (value: unknown, human?: () => string) => void, io: Io) {
  print(result, () => {
    switch (result.status) {
      case "running": return `Still running: camelrun runs get ${result.agent} ${result.requestId} --wait 60`;
      case "failed": return `Failed (${result.error?.code}): ${result.error?.message}`;
      case "input_required": return [result.text, ...(result.inputs ?? []).map(input => `Waiting on ${input.kind} ${input.id}: ${input.message ?? JSON.stringify(input.detail)}\n  camelrun answer ${result.agent} ${input.id} <value>`)].filter(Boolean).join("\n");
      default: return [result.text || "(no reply)", ...(result.toolErrors ?? []).map(error => `tool error: ${JSON.stringify(error)}`)].join("\n");
    }
  });
  if (result.status === "failed") return 1;
  if (result.status === "input_required") { if (io.tty) io.err("(the run waits on the input above)"); return 2; }
  return 0;
}

function table(rows: any[], columns: string[]) {
  const cell = (value: unknown) => value === null || value === undefined ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const widths = columns.map(column => Math.max(column.length, ...rows.map(row => cell(row[column]).length)));
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  return [line(columns), ...rows.map(row => line(columns.map(column => cell(row[column]))))].join("\n");
}

function describeDeploy(result: ops.DeployResult) {
  const lines = [`${result.key}: ${result.status}${result.status === "planned" ? ` (now at revision ${result.revision || "none"})` : ` (${result.id}, revision ${result.revision})`}`];
  for (const source of (result.toolSources ?? []) as any[]) lines.push(`  tools from ${source.name}: ${source.status === "error" ? `error: ${source.error}` : `${source.tools?.length ?? 0} tools`}`);
  for (const applied of result.applied ?? []) lines.push(`  applied to ${applied.agent}: ${applied.status}${applied.error ? ` (${applied.error})` : ""}`);
  if (result.status === "updated" && !result.applied) lines.push("  live agents keep their revision; deploy with --apply to move them");
  for (const agent of result.agents) lines.push(`  agent ${agent.key}: ${agent.status}${agent.id ? ` (${agent.id})` : ""}${agent.reconfigured ? ", reconfigured between its turns" : ""}${agent.error ? `: ${agent.error}` : ""}`);
  return lines.join("\n");
}

