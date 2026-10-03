import { z } from "zod";
import { Api, enc } from "./api.ts";
import { parseManifests, type Manifest } from "./manifest.ts";
import * as ops from "./ops.ts";

/**
 * The camelRun tools, one list for every surface: `camelrun mcp` (stdio), the runtime's hosted /mcp, and the
 * console's WebMCP. It reads no files and no environment itself, so it runs in browsers; only `local` (the stdio
 * server on the user's machine) lets deploy read manifests from disk and `${NAME}` from the environment.
 */
/**
 * How a tool behaves, as MCP's annotations say it, always all three: whether it changes anything; whether what it
 * changes is overwritten, deleted or cannot be taken back (so clients ask first); and whether it reaches beyond the
 * account (an agent's run can search and fetch the web, and call the tool servers it was given).
 */
export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean }
export interface ToolSpec {
  name: string;
  /** A short name for people, as clients show it. */
  title: string;
  description: string;
  /** The arguments, as a zod shape: z.object(input) validates them, and z.toJSONSchema describes them. */
  input: z.ZodRawShape;
  annotations: ToolAnnotations;
  run(args: any): Promise<unknown>;
}
export interface LocalFiles {
  env: Record<string, string | undefined>;
  /** Files a manifest given inline names, relative to the working directory. */
  readFile(relativePath: string): string;
  /** The manifests in `file`, or the working directory's agent.yaml. */
  load(file?: string): Manifest[];
}

export const INSTRUCTIONS = `Deploy and manage agents on camelRun (https://run.camelai.com).

- An agent is durable and keyed: the same key is the same agent, with its history, until deleted. Tools take an agent's key or its id (client_…).
- A definition is a reusable configuration (model, system prompt, built-ins, MCP servers, OpenAPI specs). Keep it in the repository as agent.yaml and deploy it with deploy: the same key is the same definition, and deploying again makes a new revision. apply: true also moves live agents to it between their turns.
- run_agent sends a message and waits up to wait seconds. A run still going comes back with status "running": call get_run with its requestId. A run with status "input_required" waits on a person: show them its inputs, then answer_input.
- read_docs reads the runtime's documentation (the manifest's fields are in guides/definitions.md).`;

const agent = z.string().describe("The agent's key, or its id (client_…)");
const definition = z.string().describe("The definition's key, or its id (def_…)");
const wait = z.number().min(0).max(300).optional().describe("Seconds to wait for the run to end (default 50); a run still going comes back as running");


/** Every tool, for `api`. */
export function tools(api: () => Api, options: { local?: LocalFiles } = {}): ToolSpec[] {
  const list: ToolSpec[] = [];
  const tool = <S extends z.ZodRawShape>(name: string, title: string, description: string, input: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, annotations: ToolAnnotations) => {
    list.push({ name, title, description, input, annotations, run });
  };
  const read: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  // Adds to the account and changes nothing already there.
  const add: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  // Overwrites, deletes or stops something, or cannot be taken back.
  const destructive: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  tool("whoami", "Show account", "The camelRun account (tenant) these credentials act for, the runtime's URL and the default model. Changes nothing.", {}, async () => {
    const client = api();
    return { ...await client.me(), url: client.url };
  }, read);

  tool("list_models", "List models", "The models agents can use, with context window, reasoning support and price: pass a model's id as `model` to create_agent, configure_agent or a manifest. Changes nothing.", { available: z.boolean().optional().describe("Only models the account has a key for (default true)") }, async ({ available }) => {
    const models: any[] = await api().get(`/v1/models${available === false ? "" : "?available=true"}`);
    return models.map(({ id, name, contextWindow, reasoning, cost, available }) => ({ id, name, available, contextWindow, reasoning, cost }));
  }, read);

  const local = options.local;
  const hosted = !local;
  tool("deploy", "Deploy agent manifest",
    "Deploy agent manifests: upsert each definition by its key (a new revision only when it changed, replacing the current one) and make or update the keyed agents it lists. Use dryRun first to show what would change. " +
    (hosted
      ? "Give `manifest`, the YAML itself (as an agent.yaml holds it). This server reads no files and no environment variables: put the system prompt in systemPrompt and any OpenAPI spec in spec. Never ask a person to paste credentials into the conversation: a manifest whose tool servers need secrets is deployed with the camelrun CLI, which reads them from its environment."
      : "Give `file` (a path to an agent.yaml; default ./agent.yaml) or `manifest` (the YAML itself). `${NAME}` in strings reads this server's environment."),
    {
      ...(hosted ? {} : { file: z.string().optional().describe("Path to the manifest, relative to the working directory") }),
      manifest: hosted ? z.string().describe("The manifest's YAML") : z.string().optional().describe("The manifest's YAML, instead of a file"),
      apply: z.boolean().optional().describe("Also move live agents made from the definition to the new revision, between their turns"),
      dryRun: z.boolean().optional().describe("Show what would be deployed, credentials hidden, without changing anything"),
    },
    async (args: Record<string, unknown>) => {
      const { file, manifest, apply, dryRun } = args as { file?: string; manifest?: string; apply?: boolean; dryRun?: boolean };
      if (file && manifest) throw new Error("Give file or manifest, not both");
      const manifests = manifest !== undefined
        ? parseManifests(manifest, "manifest", local
          ? { env: local.env, readFile: local.readFile }
          : { noEnv: "a hosted deploy reads no environment variables: write the value in, or deploy with the camelrun CLI" })
        : local!.load(file);
      const results = await ops.deploy(api(), manifests, { apply, dryRun });
      return dryRun ? results.map((result, index) => ({ ...result, definition: ops.redact(manifests[index].definition) })) : results;
    }, destructive);

  tool("list_definitions", "List definitions", "The account's definitions (reusable agent configurations): id, key, revision, model and built-in tools. Changes nothing.", {}, async () => {
    const list: any[] = await api().get("/v1/definitions");
    return list.map(({ id, name, revision, model, builtins, updatedAt }) => ({ id, name, revision, model, builtins, updatedAt }));
  }, read);
  tool("get_definition", "Get definition", "A definition in full: model, system prompt, built-ins and tool sources (never their credentials). Changes nothing.", { definition }, async ({ definition }) => {
    const client = api();
    return client.get(`/v1/definitions/${await client.definitionId(definition)}`);
  }, read);
  tool("definition_agents", "List a definition's agents", "The agents made from a definition, and the revision each has. Changes nothing.", { definition }, async ({ definition }) => {
    const client = api();
    return client.get(`/v1/definitions/${await client.definitionId(definition)}/agents`);
  }, read);
  tool("delete_definition", "Delete definition", "Delete a definition and its revisions; this cannot be undone, so confirm with the person first. Agents made from it keep running as they are.", { definition }, async ({ definition }) => {
    const client = api();
    return client.call("DELETE", `/v1/definitions/${await client.definitionId(definition)}`);
  }, destructive);

  tool("list_agents", "List agents", "The account's agents: key, id, name and model. `loaded` is whether the agent is in a runtime's memory now, idle or not; it says nothing about whether a run is going (run_agent and get_run do). `toolsConnected` is whether an application serving its attached tools is connected. Changes nothing.", {}, async () => {
    const list: any[] = await api().get("/v1/agents");
    return list.map(({ id, key, name, model, running, connected, expiresAt }) => ({ key, id, name, model, loaded: running, toolsConnected: connected, expiresAt }));
  }, read);
  tool("get_agent", "Get agent", "An agent's configuration, the definition revision it has, and every source of its tools with what each offers. Changes nothing.", { agent }, async ({ agent }) => {
    const client = api();
    return client.get(`/v1/agents/${enc(await client.agentId(agent))}`);
  }, read);
  tool("create_agent", "Create agent",
    "Make the agent for a key: from a definition, or with its own model and system prompt. The same key is the same agent, so calling it again for a key that exists updates that agent to the configuration given, keeping its history. It lives until deleted.",
    {
      key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).describe("Your name for the agent: 1 to 80 letters, digits, _ and -"),
      definition: definition.optional(),
      model: z.string().optional().describe("A model id from list_models"),
      systemPrompt: z.string().optional().describe("Not with a definition, which owns the prompt"),
      systemPromptAppend: z.string().optional().describe("Text after the prompt, e.g. this agent's own context"),
      name: z.string().optional(),
      builtins: z.array(z.enum(["web_fetch", "web_search", "schedule", "ask_user"])).optional().describe("Without a definition: tools the runtime answers itself"),
    },
    ({ key, ...config }) => ops.upsertAgent(api(), key, config), { ...destructive, idempotentHint: true });
  tool("configure_agent", "Configure agent", "Change one agent's model, system prompt, prompt addition or thinking level between its runs, replacing the current values; its history is kept.", {
    agent,
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    systemPromptAppend: z.string().optional().describe("\"\" removes it"),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  }, ({ agent, ...changes }) => {
    const given = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    if (!Object.keys(given).length) throw new Error("Nothing to change");
    return ops.configure(api(), agent, given);
  }, destructive);
  tool("fork_agent", "Fork agent",
    "Make a new agent from an existing one: the same configuration, a copy of its conversation and a copy of its files, each its own from then on, so the copy can try another direction while the original stays as it was. By default the copy ends with the last turn that finished; atMessage ends it earlier. With a key it lives until deleted, and calling again with the same key returns the same fork.",
    {
      agent,
      key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe("The fork's own key: 1 to 80 letters, digits, _ and -. Without one it is a scratch agent that lives a day"),
      name: z.string().optional(),
      atMessage: z.union([z.number().int().min(0), z.string()]).optional().describe("Where the copied conversation ends: a message's index in agent_history, or a run's requestId (its whole turn)"),
    },
    async ({ agent, ...options }) => {
      const client = api();
      const { token: _token, ...forked } = await client.call("POST", `/v1/agents/${enc(await client.agentId(agent))}/fork`, Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)));
      return forked;
    }, add);
  tool("delete_agent", "Delete agent", "Delete an agent: it stops at once, and its history and files are purged; this cannot be undone, so confirm with the person first. Its key makes a fresh agent next time.", { agent }, async ({ agent }) => {
    const client = api();
    return client.call("DELETE", `/v1/agents/${enc(await client.agentId(agent))}`);
  }, destructive);

  tool("run_agent", "Run agent",
    "Send an agent a message and wait for its run: the reply, the input it waits on, or why it failed. A run still going after `wait` seconds comes back as running; call get_run. The agent acts with the tools it was given (such as web search and its MCP servers), and the run uses the account's model credit.",
    {
      agent, message: z.string(), wait,
      from: z.string().optional().describe("Who is sending, as a user id in the application"),
      steer: z.boolean().optional().describe("If a run is going, have it read this after its current step instead of queuing it"),
      allowDisconnected: z.boolean().optional().describe("Run even though the application serving its attached tools is not connected; those calls then fail"),
      requestId: z.string().optional().describe("Retrying with the same id is the same run"),
    },
    ({ agent, message, wait, ...options }) => ops.run(api(), agent, message, { ...options, wait: wait ?? 50 }), { ...add, openWorldHint: true });
  tool("get_run", "Get run", "A run's status and result, waiting up to `wait` seconds for it to end. Changes nothing.", { agent, requestId: z.string(), wait }, async ({ agent, requestId, wait }) => {
    const client = api();
    return ops.waitFor(client, await client.agentId(agent), requestId, wait ?? 50);
  }, read);
  tool("agent_history", "Read agent history", "An agent's latest messages, in whole turns: text, tool calls and tool results. Changes nothing.", { agent, limit: z.number().int().min(1).max(500).optional().describe("Default 20") }, ({ agent, limit }) => ops.history(api(), agent, limit), read);
  tool("abort_agent", "Stop agent's turn", "Stop an agent's running turn; the turn's unfinished work is cancelled. The agent and its history stay.", { agent }, async ({ agent }) => {
    const client = api();
    return client.call("POST", `/v1/agents/${enc(await client.agentId(agent))}/abort`, {});
  }, destructive);

  tool("list_inputs", "List pending inputs", "Questions, approvals and forms waiting on a person: one agent's, or every agent's. Changes nothing.", { agent: agent.optional() }, async ({ agent }) => {
    const client = api();
    return agent ? client.get(`/v1/agents/${enc(await client.agentId(agent))}/inputs?state=pending`) : client.get("/v1/inputs?state=pending");
  }, read);
  tool("answer_input", "Answer input",
    "Answer an input and wait for the run it resumes. An approval takes true or false; a question the chosen label or your own words (several questions: {\"<question>\": \"<answer>\"}); a form its fields; \"decline\" declines. Only answer with what the person decided: an answer cannot be taken back, and an approval lets the agent go ahead with what it asked to do.",
    { agent, inputId: z.string(), value: z.union([z.boolean(), z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]), from: z.string().optional().describe("Who is answering, as a user id in the application"), wait },
    ({ agent, inputId, value, from, wait }) => ops.answer(api(), agent, inputId, value, { from, wait: wait ?? 50 }), { ...destructive, openWorldHint: true });

  tool("list_schedules", "List schedules", "An agent's scheduled wake-ups. Changes nothing.", { agent }, async ({ agent }) => {
    const client = api();
    return client.get(`/v1/agents/${enc(await client.agentId(agent))}/schedules`);
  }, read);
  tool("add_schedule", "Add schedule", "Wake an agent later with a message: once (inSeconds or at), or repeatedly (everySeconds, at least 60). Each wake-up is a run that uses the account's model credit.", {
    agent, text: z.string(),
    inSeconds: z.number().optional(), at: z.string().optional().describe("ISO time"), everySeconds: z.number().int().min(60).optional(),
  }, async ({ agent, ...schedule }) => {
    const client = api();
    return client.call("POST", `/v1/agents/${enc(await client.agentId(agent))}/schedules`, schedule);
  }, { ...add, openWorldHint: true });
  tool("delete_schedule", "Delete schedule", "Cancel a scheduled wake-up; this cannot be undone.", { agent, scheduleId: z.string() }, async ({ agent, scheduleId }) => {
    const client = api();
    return client.call("DELETE", `/v1/agents/${enc(await client.agentId(agent))}/schedules/${enc(scheduleId)}`);
  }, destructive);

  tool("read_docs", "Read camelRun docs", "camelRun's own documentation as Markdown: with no path, the index (llms.txt); else a page such as guides/definitions.md, guides/tools.md or reference/cli.md. Changes nothing.", {
    path: z.string().regex(/^(?!.*\.\.)[A-Za-z0-9/_.-]*$/).optional(),
  }, ({ path }) => api().text(path ? `/docs/${path.replace(/^\/?(docs\/)?/, "")}` : "/llms.txt"), read);

  return list;
}

/** A tool's result as text, as MCP and WebMCP clients take it. */
export const resultText = (result: unknown) => typeof result === "string" ? result : JSON.stringify(result, null, 2);
/** An error as the model should read it: the HTTP status, when there was one, and the message. */
export const errorText = (error: unknown) => `${(error as any)?.status ? `${(error as any).status}: ` : ""}${(error as Error).message}`;
