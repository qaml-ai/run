import { isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { Api, enc } from "./api.ts";
import { VERSION } from "./cli.ts";
import { findManifest, interpolate, loadManifests, parseManifest } from "./manifest.ts";
import * as ops from "./ops.ts";

const INSTRUCTIONS = `Deploy and manage agents on the camelAI agent runtime (https://agents.camelai.dev).

- An agent is durable and keyed: the same key is the same agent, with its history, until deleted. Tools take an agent's key or its id (client_…).
- A definition is a reusable configuration (model, system prompt, built-ins, MCP servers, OpenAPI specs). Keep it in the repository as agent.yaml and deploy it with deploy: the same key is the same definition, and deploying again makes a new revision. apply: true also moves live agents to it between their turns.
- run_agent sends a message and waits up to wait seconds. A run still going comes back with status "running": call get_run with its requestId. A run with status "input_required" waits on a person: show them its inputs, then answer_input.
- read_docs reads the runtime's documentation (the manifest's fields are in guides/definitions.md).`;

const agent = z.string().describe("The agent's key, or its id (client_…)");
const definition = z.string().describe("The definition's key, or its id (def_…)");
const wait = z.number().min(0).max(300).optional().describe("Seconds to wait for the run to end (default 50); a run still going comes back as running");

/** Serve the CLI's operations as MCP tools over stdio. Credentials are read on each call, so a login takes effect at once. */
export async function serve(api: () => Api, cwd: string) {
  const server = createServer(api, cwd);
  // The transport does not notice its client going away: stdin ending is that.
  const closed = new Promise<void>(resolve => { server.server.onclose = resolve; process.stdin.once("end", resolve); });
  await server.connect(new StdioServerTransport());
  await closed;
  await server.close();
}

export function createServer(api: () => Api, cwd: string) {
  const server = new McpServer({ name: "camelai-agents", version: VERSION }, { instructions: INSTRUCTIONS });
  const tool = <S extends z.ZodRawShape>(name: string, description: string, input: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {}) => {
    server.registerTool(name, { description, inputSchema: input, annotations }, (async (args: any) => {
      try {
        const result = await handler(args);
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const status = (error as any).status;
        return { isError: true, content: [{ type: "text", text: `${status ? `${status}: ` : ""}${(error as Error).message}` }] };
      }
    }) as any);
  };
  const read = { readOnlyHint: true };

  tool("whoami", "The tenant the API key belongs to, the runtime's URL and the default model.", {}, async () => {
    const client = api();
    return { ...await client.me(), url: client.url };
  }, read);

  tool("list_models", "Models agents can use: pass a model's id as `model`.", { available: z.boolean().optional().describe("Only models the account has a key for (default true)") }, async ({ available }) => {
    const models: any[] = await api().get(`/v1/models${available === false ? "" : "?available=true"}`);
    return models.map(({ id, name, contextWindow, reasoning, cost, available }) => ({ id, name, available, contextWindow, reasoning, cost }));
  }, read);

  tool("deploy",
    "Deploy agent manifests: upsert each definition by its key (a new revision only when it changed) and make the keyed agents it lists. " +
    "Give `file` (a path to an agent.yaml; default ./agent.yaml) or `manifest` (the YAML itself). `${NAME}` in strings reads this server's environment.",
    {
      file: z.string().optional().describe("Path to the manifest, relative to the working directory"),
      manifest: z.string().optional().describe("The manifest's YAML, instead of a file"),
      apply: z.boolean().optional().describe("Also move live agents made from the definition to the new revision, between their turns"),
      dryRun: z.boolean().optional().describe("Show what would be deployed, credentials hidden, without changing anything"),
    },
    async ({ file, manifest, apply, dryRun }) => {
      if (file && manifest) throw new Error("Give file or manifest, not both");
      const manifests = manifest
        ? parseAllDocuments(manifest).map(document => document.toJS()).filter(Boolean).map(document => parseManifest(interpolate(document, process.env, "manifest"), resolve(cwd, "agent.yaml"), "manifest"))
        : loadManifests(file ? (isAbsolute(file) ? file : resolve(cwd, file)) : findManifest(cwd));
      const results = await ops.deploy(api(), manifests, { apply, dryRun });
      return dryRun ? results.map((result, index) => ({ ...result, definition: ops.redact(manifests[index].definition) })) : results;
    });

  tool("list_definitions", "The account's definitions.", {}, async () => {
    const list: any[] = await api().get("/v1/definitions");
    return list.map(({ id, name, revision, model, builtins, updatedAt }) => ({ id, name, revision, model, builtins, updatedAt }));
  }, read);
  tool("get_definition", "A definition in full: model, prompt, built-ins and tool sources (never their credentials).", { definition }, async ({ definition }) => {
    const client = api();
    return client.get(`/v1/definitions/${await client.definitionId(definition)}`);
  }, read);
  tool("definition_agents", "The agents made from a definition, and the revision each has.", { definition }, async ({ definition }) => {
    const client = api();
    return client.get(`/v1/definitions/${await client.definitionId(definition)}/agents`);
  }, read);
  tool("delete_definition", "Delete a definition. Its agents are left as they are.", { definition }, async ({ definition }) => {
    const client = api();
    return client.call("DELETE", `/v1/definitions/${await client.definitionId(definition)}`);
  }, { destructiveHint: true });

  tool("list_agents", "The account's agents: key, id, model, and whether each is running.", {}, () => api().get("/v1/agents"), read);
  tool("get_agent", "An agent's configuration, the definition revision it has, and every source of its tools with what each offers.", { agent }, async ({ agent }) => {
    const client = api();
    return client.get(`/v1/agents/${enc(await client.agentId(agent))}`);
  }, read);
  tool("create_agent",
    "Make the agent for a key, or find it: from a definition, or with its own model and system prompt. The same key is the same agent; it lives until deleted.",
    {
      key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).describe("Your name for the agent: 1 to 80 letters, digits, _ and -"),
      definition: definition.optional(),
      model: z.string().optional().describe("A model id from list_models"),
      systemPrompt: z.string().optional().describe("Not with a definition, which owns the prompt"),
      systemPromptAppend: z.string().optional().describe("Text after the prompt, e.g. this agent's own context"),
      name: z.string().optional(),
      builtins: z.array(z.enum(["web_fetch", "web_search", "schedule", "ask_user"])).optional().describe("Without a definition: tools the runtime answers itself"),
    },
    ({ key, ...config }) => ops.upsertAgent(api(), key, config), { idempotentHint: true });
  tool("configure_agent", "Change one agent's model, system prompt, prompt addition or thinking level between its runs; its history is kept.", {
    agent,
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    systemPromptAppend: z.string().optional().describe("\"\" removes it"),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  }, ({ agent, ...changes }) => {
    const given = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    if (!Object.keys(given).length) throw new Error("Nothing to change");
    return ops.configure(api(), agent, given);
  });
  tool("delete_agent", "Delete an agent: it stops at once, and its history and files are purged. Its key makes a fresh agent next time.", { agent }, async ({ agent }) => {
    const client = api();
    return client.call("DELETE", `/v1/agents/${enc(await client.agentId(agent))}`);
  }, { destructiveHint: true });

  tool("run_agent",
    "Send an agent a message and wait for its run: the reply, the input it waits on, or why it failed. A run still going after `wait` seconds comes back as running; call get_run.",
    {
      agent, message: z.string(), wait,
      from: z.string().optional().describe("Who is sending, as a user id in the application"),
      steer: z.boolean().optional().describe("If a run is going, have it read this after its current step instead of queuing it"),
      allowDisconnected: z.boolean().optional().describe("Run even though the application serving its attached tools is not connected; those calls then fail"),
      requestId: z.string().optional().describe("Retrying with the same id is the same run"),
    },
    ({ agent, message, wait, ...options }) => ops.run(api(), agent, message, { ...options, wait: wait ?? 50 }));
  tool("get_run", "A run's status and result, waiting up to `wait` seconds for it to end.", { agent, requestId: z.string(), wait }, async ({ agent, requestId, wait }) => {
    const client = api();
    return ops.waitFor(client, await client.agentId(agent), requestId, wait ?? 50);
  }, read);
  tool("agent_history", "An agent's latest messages, in whole turns: text, tool calls and tool results.", { agent, limit: z.number().int().min(1).max(500).optional().describe("Default 20") }, ({ agent, limit }) => ops.history(api(), agent, limit), read);
  tool("abort_agent", "Stop an agent's running turn.", { agent }, async ({ agent }) => {
    const client = api();
    return client.call("POST", `/v1/agents/${enc(await client.agentId(agent))}/abort`, {});
  });

  tool("list_inputs", "Questions, approvals and forms waiting on a person: one agent's, or every agent's.", { agent: agent.optional() }, async ({ agent }) => {
    const client = api();
    return agent ? client.get(`/v1/agents/${enc(await client.agentId(agent))}/inputs?state=pending`) : client.get("/v1/inputs?state=pending");
  }, read);
  tool("answer_input",
    "Answer an input and wait for the run it resumes. An approval takes true or false; a question the chosen label or your own words (several questions: {\"<question>\": \"<answer>\"}); a form its fields; \"decline\" declines. Only answer with what the person decided.",
    { agent, inputId: z.string(), value: z.union([z.boolean(), z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]), from: z.string().optional().describe("Who is answering, as a user id in the application"), wait },
    ({ agent, inputId, value, from, wait }) => ops.answer(api(), agent, inputId, value, { from, wait: wait ?? 50 }));

  tool("list_schedules", "An agent's scheduled wake-ups.", { agent }, async ({ agent }) => {
    const client = api();
    return client.get(`/v1/agents/${enc(await client.agentId(agent))}/schedules`);
  }, read);
  tool("add_schedule", "Wake an agent later with a message: once (inSeconds or at), or repeatedly (everySeconds, at least 60).", {
    agent, text: z.string(),
    inSeconds: z.number().optional(), at: z.string().optional().describe("ISO time"), everySeconds: z.number().int().min(60).optional(),
  }, async ({ agent, ...schedule }) => {
    const client = api();
    return client.call("POST", `/v1/agents/${enc(await client.agentId(agent))}/schedules`, schedule);
  });
  tool("delete_schedule", "Cancel a scheduled wake-up.", { agent, scheduleId: z.string() }, async ({ agent, scheduleId }) => {
    const client = api();
    return client.call("DELETE", `/v1/agents/${enc(await client.agentId(agent))}/schedules/${enc(scheduleId)}`);
  }, { destructiveHint: true });

  tool("read_docs", "The runtime's documentation as Markdown: with no path, the index (llms.txt); else a page such as guides/definitions.md, guides/tools.md or concepts.md.", {
    path: z.string().optional(),
  }, async ({ path }) => {
    const url = api().url;
    const page = path ? `/docs/${path.replace(/^\/?(docs\/)?/, "")}` : "/llms.txt";
    const response = await fetch(url + page);
    if (!response.ok) throw new Error(`${page}: ${response.status}`);
    return response.text();
  }, read);

  return server;
}
