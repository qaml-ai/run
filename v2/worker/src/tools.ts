import { getAgentStub } from "./agent-do.ts";
import { CamelFsClient, normalizeRepoPath } from "./camelfs.ts";
import { mintAgentToken, randomId, sealSecret } from "./crypto.ts";
import { discoverMcpTools, invokeMcpTool, type DiscoveredMcpTool } from "./mcp.ts";
import { runCodemodeScript } from "./sandbox.ts";
import { getTenantStub } from "./tenant-do.ts";
import {
  ApiError,
  extractApiError,
  type AgentConfig,
  type BuiltinSuite,
  type CustomToolSpec,
  type Env,
  type LlmToolSchema,
  type RunRecord,
} from "./types.ts";
import { executeAgentWorkflow } from "./workflows.ts";

export class PauseForInputSignal extends Error {
  readonly kind: "approval" | "question";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly promptPayload: Record<string, unknown>;

  constructor(opts: {
    kind: "approval" | "question";
    toolCallId: string;
    toolName: string;
    promptPayload: Record<string, unknown>;
  }) {
    super(`Paused for human ${opts.kind}`);
    this.name = "PauseForInputSignal";
    this.kind = opts.kind;
    this.toolCallId = opts.toolCallId;
    this.toolName = opts.toolName;
    this.promptPayload = opts.promptPayload;
  }
}

export interface ToolExecutionContext {
  env: Env;
  config: AgentConfig;
  runId: string;
  approvedToolCallIds: Set<string>;
  codemodeDepth?: number;
  signal?: AbortSignal;
  ensureAgentRepo(): Promise<{ repoId: string; lineage: string; branch: string }>;
  getVmSession(branch: string): { vmId: string; leaseExpiresAt: number } | null;
  saveVmSession(branch: string, vmId: string, leaseExpiresAt: number): void;
  clearVmSession(branch: string, vmId: string): void;
  recordFilesChanged(files: string[]): void;
  recordVmMs(ms: number): void;
  invokeWebSocketTool(name: string, args: Record<string, unknown>, callId: string): Promise<unknown>;
  hasWebSocketTool(name: string): boolean;
  recordChildAgent(entry: {
    id: string;
    childAgentId: string;
    childAgentKey: string;
    parentRunId: string;
    status: string;
    result: unknown;
  }): void;
  getChildAgent(idOrAgentId: string): {
    id: string;
    childAgentId: string;
    childAgentKey: string;
    status: string;
    result: unknown;
  } | null;
  getCachedWorkflowStep(scope: string, stepKey: string): unknown | undefined;
  putCachedWorkflowStep(scope: string, stepKey: string, value: unknown): void;
  runInlineSubprompt(prompt: string, opts?: Record<string, unknown>): Promise<unknown>;
}

const BUILTIN_SCHEMAS: Record<BuiltinSuite, LlmToolSchema[]> = {
  files: [
    {
      name: "read_file",
      description: "Read file contents from the agent repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path in the repo" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file in the agent repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          message: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "Replace an exact string occurrence inside a repository file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
    {
      name: "list_files",
      description: "List files and directories in the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
          glob: { type: "string" },
        },
      },
    },
    {
      name: "grep_files",
      description: "Search repository files with a regular expression.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          pathPrefix: { type: "string" },
          maxMatches: { type: "number" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          message: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      name: "repo_checkpoint",
      description: "Create a named checkpoint ref pointing at the current branch head commit.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    },
    {
      name: "repo_restore",
      description: "Restore the repository branch to a target commit.",
      parameters: {
        type: "object",
        properties: {
          targetCommit: { type: "string" },
          message: { type: "string" },
        },
        required: ["targetCommit"],
      },
    },
    {
      name: "repo_diff",
      description: "Compute diff between two commits or refs in the repository.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
    {
      name: "repo_history",
      description: "List recent commits on the current repository branch.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number" },
        },
      },
    },
  ],
  bash: [
    {
      name: "bash",
      description:
        "Execute a bash command inside the persistent session VM over /workspace with atomic Git commits.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutS: { type: "number" },
        },
        required: ["command"],
      },
    },
  ],
  codemode: [
    {
      name: "codemode",
      description:
        "Execute sandboxed JavaScript in QuickJS with async access to `tools.<name>(args)` and `fs.readFile/writeFile/readdir`.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Async JavaScript body (can use await and return)" },
        },
        required: ["code"],
      },
    },
  ],
  delegate: [
    {
      name: "delegate",
      description:
        "Synchronously delegate a task to a child agent (optionally on a forked repo) and return its result.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          key: { type: "string" },
          model: { type: "string" },
          instructions: { type: "string" },
          forkRepo: { type: "boolean" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "spawn_agent",
      description: "Start an asynchronous child agent run and return its handle.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          key: { type: "string" },
          model: { type: "string" },
          instructions: { type: "string" },
          forkRepo: { type: "boolean" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "send_message",
      description: "Send a follow-up prompt or mid-turn steer message to a child agent.",
      parameters: {
        type: "object",
        properties: {
          childId: { type: "string" },
          prompt: { type: "string" },
          whileRunning: { type: "string", enum: ["queue", "steer"] },
        },
        required: ["childId", "prompt"],
      },
    },
    {
      name: "wait_agent",
      description: "Wait for an asynchronous child agent run to finish and return its output.",
      parameters: {
        type: "object",
        properties: {
          childId: { type: "string" },
          runId: { type: "string" },
        },
        required: ["childId"],
      },
    },
  ],
  workflows: [
    {
      name: "workflow_run",
      description:
        "Execute a deterministic replay-cached workflow script with `wf.agent`, `wf.parallel`, `wf.bash`, `wf.commit`, `wf.sleep`.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["code"],
      },
    },
  ],
  web_search: [
    {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
  ],
  web_fetch: [
    {
      name: "web_fetch",
      description: "Fetch an HTTP/HTTPS URL and return its response text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["url"],
      },
    },
  ],
  human: [
    {
      name: "ask_human",
      description: "Pause the run and request clarification, input, or confirmation from a human.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question"],
      },
    },
  ],
};

export interface BuiltToolCatalog {
  schemas: LlmToolSchema[];
  customByName: Map<string, CustomToolSpec>;
  mcpByName: Map<string, DiscoveredMcpTool>;
}

export async function buildToolCatalog(
  config: AgentConfig,
  env: Env,
  signal?: AbortSignal,
): Promise<BuiltToolCatalog> {
  const schemas: LlmToolSchema[] = [];
  const seen = new Set<string>();
  const customByName = new Map<string, CustomToolSpec>();
  const mcpByName = new Map<string, DiscoveredMcpTool>();

  for (const tool of config.tools ?? []) {
    if (!tool.name || seen.has(tool.name)) continue;
    seen.add(tool.name);
    customByName.set(tool.name, tool);
    schemas.push({
      name: tool.name,
      description: tool.description || `Tool ${tool.name}`,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    });
  }

  for (const suite of config.builtins ?? []) {
    const suiteTools = BUILTIN_SCHEMAS[suite] ?? [];
    for (const st of suiteTools) {
      if (seen.has(st.name)) continue;
      seen.add(st.name);
      schemas.push(st);
    }
  }

  const mcpTools = await discoverMcpTools(env, config, signal);
  for (const mt of mcpTools) {
    if (seen.has(mt.qualifiedName)) continue;
    seen.add(mt.qualifiedName);
    mcpByName.set(mt.qualifiedName, mt);
    schemas.push(mt.schema);
  }

  return { schemas, customByName, mcpByName };
}

export async function executeToolCall(
  ctx: ToolExecutionContext,
  catalog: BuiltToolCatalog,
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // 1. Human input tool
  if (toolName === "ask_human") {
    throw new PauseForInputSignal({
      kind: "question",
      toolCallId: callId,
      toolName,
      promptPayload: {
        question: String(args.question ?? "Input requested"),
        options: Array.isArray(args.options) ? args.options : undefined,
        args,
      },
    });
  }

  // 2. Custom tools (HTTP webhook OR attached WebSocket SDK tool)
  const custom = catalog.customByName.get(toolName);
  if (custom) {
    if (custom.requiresApproval && !ctx.approvedToolCallIds.has(callId)) {
      throw new PauseForInputSignal({
        kind: "approval",
        toolCallId: callId,
        toolName,
        promptPayload: {
          tool: toolName,
          args,
          message: `Approve execution of tool '${toolName}'?`,
        },
      });
    }

    if (custom.url) {
      const res = await fetch(custom.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CamelRun-Agent": ctx.config.id,
          "X-CamelRun-Run": ctx.runId,
          ...(custom.headers ?? {}),
        },
        body: JSON.stringify({
          callId,
          agentId: ctx.config.id,
          runId: ctx.runId,
          name: toolName,
          args,
        }),
        signal: ctx.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Webhook tool '${toolName}' returned HTTP ${res.status}: ${text}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    if (ctx.hasWebSocketTool(toolName)) {
      return ctx.invokeWebSocketTool(toolName, args, callId);
    }

    throw new Error(
      `Tool '${toolName}' has no webhook url and no connected WebSocket client registered it`,
    );
  }

  // 3. Remote MCP tools
  const mcpTool = catalog.mcpByName.get(toolName);
  if (mcpTool) {
    return invokeMcpTool(mcpTool, args, { env: ctx.env, agent: ctx.config, call: { runId: ctx.runId, callId } }, ctx.signal);
  }

  // 4. Built-in Repo File tools
  if (
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "list_files" ||
    toolName === "grep_files" ||
    toolName === "delete_file" ||
    toolName === "repo_checkpoint" ||
    toolName === "repo_restore" ||
    toolName === "repo_diff" ||
    toolName === "repo_history"
  ) {
    const { repoId, lineage, branch } = await ctx.ensureAgentRepo();
    const cfs = new CamelFsClient(ctx.env, ctx.config.tenantId);

    if (toolName === "read_file") {
      const path = normalizeRepoPath(String(args.path ?? ""));
      return cfs.read(lineage, {
        at: typeof args.at === "string" ? args.at : branch,
        path,
        offset: typeof args.offset === "number" ? args.offset : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
    }

    if (toolName === "write_file") {
      const path = normalizeRepoPath(String(args.path ?? ""));
      const content = String(args.content ?? "");
      const out = await cfs.write(lineage, {
        ref: branch,
        holder: ctx.config.id,
        author: `agent:${ctx.config.id}`,
        message: typeof args.message === "string" ? args.message : `write ${path}`,
        puts: [{ path, content, mode: 0o644 }],
      });
      ctx.recordFilesChanged(out.changed);
      void getTenantStub(ctx.env, ctx.config.tenantId)
        .updateRepoCommit(repoId, out.commit)
        .catch(() => {});
      return out;
    }

    if (toolName === "edit_file") {
      const path = normalizeRepoPath(String(args.path ?? ""));
      const oldString = String(args.oldString ?? "");
      const newString = String(args.newString ?? "");
      const replaceAll = Boolean(args.replaceAll);
      const current = await cfs.read(lineage, { at: branch, path });
      const text = current.content ?? "";
      if (!text.includes(oldString)) {
        throw new Error(`edit_file: oldString not found in '${path}'`);
      }
      const updated = replaceAll
        ? text.split(oldString).join(newString)
        : text.replace(oldString, newString);
      const out = await cfs.write(lineage, {
        ref: branch,
        holder: ctx.config.id,
        author: `agent:${ctx.config.id}`,
        message: typeof args.message === "string" ? args.message : `edit ${path}`,
        puts: [{ path, content: updated, mode: current.mode || 0o644 }],
      });
      ctx.recordFilesChanged(out.changed);
      void getTenantStub(ctx.env, ctx.config.tenantId)
        .updateRepoCommit(repoId, out.commit)
        .catch(() => {});
      return out;
    }

    if (toolName === "list_files") {
      return cfs.ls(lineage, {
        at: typeof args.at === "string" ? args.at : branch,
        path: typeof args.path === "string" ? args.path : "",
        recursive: args.recursive !== undefined ? Boolean(args.recursive) : true,
        glob: typeof args.glob === "string" ? args.glob : undefined,
      });
    }

    if (toolName === "grep_files") {
      return cfs.grep(lineage, {
        at: typeof args.at === "string" ? args.at : branch,
        pattern: String(args.pattern ?? ""),
        pathPrefix: typeof args.pathPrefix === "string" ? args.pathPrefix : undefined,
        maxMatches: typeof args.maxMatches === "number" ? args.maxMatches : 100,
      });
    }

    if (toolName === "delete_file") {
      const path = normalizeRepoPath(String(args.path ?? ""));
      const out = await cfs.write(lineage, {
        ref: branch,
        holder: ctx.config.id,
        author: `agent:${ctx.config.id}`,
        message: typeof args.message === "string" ? args.message : `delete ${path}`,
        deletes: [path],
      });
      ctx.recordFilesChanged(out.changed);
      return out;
    }

    if (toolName === "repo_checkpoint") {
      const refsRes = await cfs.listRefs(lineage, branch);
      const head = refsRes.refs.find((r) => r.name === branch) ?? refsRes.refs[0];
      if (!head) {
        throw new Error(`Branch '${branch}' not found`);
      }
      const tagName =
        typeof args.name === "string" && args.name.trim()
          ? args.name.trim().replace(/^refs\/checkpoints\//, "")
          : `cp-${Date.now()}`;
      const checkpointRef = tagName.startsWith("refs/") ? tagName : `refs/checkpoints/${tagName}`;
      return cfs.updateRef(lineage, {
        ref: checkpointRef,
        commit: head.commit,
        holder: ctx.config.id,
      });
    }

    if (toolName === "repo_restore") {
      const out = await cfs.restore(lineage, {
        ref: branch,
        targetCommit: String(args.targetCommit ?? ""),
        holder: ctx.config.id,
        author: `agent:${ctx.config.id}`,
        message: typeof args.message === "string" ? args.message : "restore checkpoint",
      });
      void getTenantStub(ctx.env, ctx.config.tenantId)
        .updateRepoCommit(repoId, out.commit)
        .catch(() => {});
      return out;
    }

    if (toolName === "repo_diff") {
      return cfs.diff(lineage, {
        from: String(args.from ?? ""),
        to: String(args.to ?? branch),
      });
    }

    if (toolName === "repo_history") {
      return cfs.history(lineage, {
        ref: branch,
        limit: typeof args.limit === "number" ? args.limit : 20,
      });
    }
  }

  // 5. Firecracker / Session VM `bash` tool
  if (toolName === "bash") {
    const { repoId, lineage, branch } = await ctx.ensureAgentRepo();
    const cfs = new CamelFsClient(ctx.env, ctx.config.tenantId);
    const command = String(args.command ?? "");

    let session = ctx.getVmSession(branch);
    if (!session || session.leaseExpiresAt <= Date.now() + 5_000) {
      const booted = await cfs.ensureVm({
        lineage,
        ref: branch,
        holder: ctx.config.id,
        leaseS: 600,
      });
      session = { vmId: booted.vmId, leaseExpiresAt: booted.leaseExpiresAt };
      ctx.saveVmSession(branch, booted.vmId, booted.leaseExpiresAt);
    }

    const execRequest = {
      execId: randomId("exec", 8),
      command,
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
      timeoutS: typeof args.timeoutS === "number" ? args.timeoutS : 60,
      commit: {
        author: `agent:${ctx.config.id}`,
        message: `bash: ${command.slice(0, 72)}`,
        skip: false,
      },
    };
    let execRes;
    try {
      execRes = await cfs.execVm(session.vmId, lineage, execRequest);
    } catch (err) {
      const apiErr = extractApiError(err);
      if (!apiErr || apiErr.status >= 500 || apiErr.code === "vm_lost") {
        // The command may have reached the guest. Refresh the VM on the next call.
        ctx.clearVmSession(branch, session.vmId);
        throw err;
      }
      // A stopped VM rejects exec before running the command.
      if (apiErr?.status !== 410 || apiErr.code !== "vm_stopped") throw err;
      const booted = await cfs.ensureVm({ lineage, ref: branch, holder: ctx.config.id });
      ctx.saveVmSession(branch, booted.vmId, booted.leaseExpiresAt);
      execRes = await cfs.execVm(booted.vmId, lineage, execRequest);
    }

    ctx.recordVmMs(execRes.billableMs || execRes.durationMs || 0);
    if (execRes.commit?.filesChanged?.length) {
      ctx.recordFilesChanged(execRes.commit.filesChanged);
    }
    if (execRes.commit?.commit) {
      void getTenantStub(ctx.env, ctx.config.tenantId)
        .updateRepoCommit(repoId, execRes.commit.commit)
        .catch(() => {});
    }
    return execRes;
  }

  // 6. QuickJS `codemode` sandbox
  if (toolName === "codemode") {
    const depth = ctx.codemodeDepth ?? 0;
    if (depth >= 2) {
      throw new Error("Nested codemode recursion limit reached");
    }
    const code = String(args.code ?? "");
    const nestedCtx: ToolExecutionContext = { ...ctx, codemodeDepth: depth + 1 };
    const out = await runCodemodeScript(code, async (innerTool, innerArgs) => {
      if (innerTool === "codemode") {
        throw new Error("Cannot invoke codemode recursively from inside codemode");
      }
      return executeToolCall(nestedCtx, catalog, randomId("cmcall", 6), innerTool, innerArgs);
    });
    return out;
  }

  // 7. Sub-agent delegation suite (`delegate`, `spawn_agent`, `send_message`, `wait_agent`)
  if (toolName === "delegate" || toolName === "spawn_agent") {
    const synchronous = toolName === "delegate";
    const childKey =
      typeof args.key === "string" && args.key.trim()
        ? args.key.trim()
        : `${ctx.config.key}__sub_${randomId("c", 4)}`;
    const prompt = String(args.prompt ?? "");
    const model = typeof args.model === "string" ? args.model : ctx.config.model;
    const instructions =
      typeof args.instructions === "string" ? args.instructions : ctx.config.instructions;

    let childRepoId: string | null = ctx.config.repoId;
    let childLineage: string | null = ctx.config.lineage;
    let childBranch = ctx.config.branch;

    if (args.forkRepo && ctx.config.lineage) {
      const cfs = new CamelFsClient(ctx.env, ctx.config.tenantId);
      const forked = await cfs.forkLineage(ctx.config.lineage, {
        sourceRef: ctx.config.branch,
      });
      const repoRec = await getTenantStub(ctx.env, ctx.config.tenantId).createRepo({
        name: `${childKey}-fork`,
        existingLineage: forked.lineage,
        defaultRef: forked.ref,
        commit: forked.commit,
      });
      childRepoId = repoRec.repoId;
      childLineage = repoRec.lineage;
      childBranch = repoRec.defaultRef;
    }

    const childAgent = await upsertChildAgentInCluster(ctx.env, ctx.config.tenantId, childKey, {
      model,
      instructions,
      builtins: ctx.config.builtins.filter((b) => b !== "delegate"),
      repoId: childRepoId,
      lineage: childLineage,
      branch: childBranch,
    });

    const stub = getAgentStub(ctx.env, childAgent.id);
    const runRecord = await stub.startRun({
      prompt,
      wait: synchronous,
    });
    const handleId = randomId("sub", 6);

    ctx.recordChildAgent({
      id: handleId,
      childAgentId: childAgent.id,
      childAgentKey: childKey,
      parentRunId: ctx.runId,
      status: runRecord.status === "completed" ? "completed" : synchronous ? "failed" : "running",
      result: runRecord,
    });

    if (synchronous) {
      return {
        id: handleId,
        childAgentId: childAgent.id,
        childKey,
        runId: runRecord.id,
        status: runRecord.status,
        text: runRecord.text,
        output: runRecord.output,
        filesChanged: runRecord.filesChanged,
      };
    }

    return {
      id: handleId,
      childAgentId: childAgent.id,
      childKey,
      runId: runRecord.id,
      status: runRecord.status,
    };
  }

  if (toolName === "send_message") {
    const targetRef = String(args.childId ?? args.childAgentId ?? "");
    const child = ctx.getChildAgent(targetRef);
    const agentId = child?.childAgentId ?? targetRef;
    return getAgentStub(ctx.env, agentId).startRun({
      prompt: String(args.prompt ?? ""),
      whileRunning: args.whileRunning === "steer" ? "steer" : "queue",
      wait: Boolean(args.wait ?? false),
    });
  }

  if (toolName === "wait_agent") {
    const targetRef = String(args.childId ?? args.childAgentId ?? "");
    const child = ctx.getChildAgent(targetRef);
    const agentId = child?.childAgentId ?? targetRef;
    const prevRun = child?.result as { id?: string } | undefined;
    const runId = typeof args.runId === "string" ? args.runId : prevRun?.id;
    const stub = getAgentStub(ctx.env, agentId);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const rec = runId
        ? await stub.getRun(runId)
        : (await stub.getState()).lastRun;
      if (
        rec &&
        (rec.status === "completed" ||
          rec.status === "failed" ||
          rec.status === "cancelled" ||
          rec.status === "input_required")
      ) {
        if (child) {
          ctx.recordChildAgent({
            id: child.id,
            childAgentId: child.childAgentId,
            childAgentKey: child.childAgentKey,
            parentRunId: ctx.runId,
            status: rec.status === "completed" ? "completed" : "failed",
            result: rec,
          });
        }
        return rec;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for child agent '${targetRef}'`);
  }

  // 8. Replay-cached workflow tool
  if (toolName === "workflow_run") {
    const wfId = randomId("wf", 8);
    const scope =
      typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
        ? `wf:${args.idempotencyKey.trim()}`
        : `wf:${wfId}`;
    return executeAgentWorkflow(wfId, scope, String(args.code ?? ""), {
      getCachedStep: (s, k) => ctx.getCachedWorkflowStep(s, k),
      putCachedStep: (s, k, v) => ctx.putCachedWorkflowStep(s, k, v),
      runAgentStep: (p, o) => ctx.runInlineSubprompt(p, o),
      runBashStep: (cmd, o) =>
        executeToolCall(ctx, catalog, randomId("wfbash", 6), "bash", {
          command: cmd,
          ...(o ?? {}),
        }),
      runCommitStep: (msg) =>
        executeToolCall(ctx, catalog, randomId("wfcp", 6), "repo_checkpoint", { name: msg }),
      runToolStep: (tName, tArgs) =>
        executeToolCall(ctx, catalog, randomId("wftool", 6), tName, tArgs),
    });
  }

  // 9. Web tools (`web_fetch` & `web_search`)
  if (toolName === "web_fetch") {
    const targetUrl = String(args.url ?? "");
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : 16_000;
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "CamelRun-Worker/2.0" },
      signal: ctx.signal,
    });
    const text = await res.text();
    return {
      url: targetUrl,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "text/plain",
      body: text.slice(0, maxChars),
    };
  }

  if (toolName === "web_search") {
    const query = String(args.query ?? "");
    try {
      const ddg = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
      const res = await fetch(ddg, { signal: ctx.signal });
      if (res.ok) {
        const json = (await res.json()) as {
          AbstractText?: string;
          AbstractURL?: string;
          RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
        };
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        if (json.AbstractText) {
          results.push({
            title: query,
            url: json.AbstractURL || "",
            snippet: json.AbstractText,
          });
        }
        for (const t of (json.RelatedTopics ?? []).slice(0, Number(args.limit ?? 5))) {
          if (t.Text) {
            results.push({
              title: t.Text.slice(0, 80),
              url: t.FirstURL || "",
              snippet: t.Text,
            });
          }
        }
        return { query, results };
      }
    } catch {
      // Offline sandbox fallback
    }
    return { query, results: [] };
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

async function upsertChildAgentInCluster(
  env: Env,
  tenantId: string,
  key: string,
  opts: {
    model: string;
    instructions: string;
    builtins: BuiltinSuite[];
    repoId: string | null;
    lineage: string | null;
    branch: string;
  },
): Promise<{ id: string; key: string }> {
  const tenantStub = getTenantStub(env, tenantId);
  const existing = await tenantStub.resolveAgent(key);
  const id = existing?.id ?? randomId("agt", 8);

  if (!existing) {
    const { token, tokenHash } = await mintAgentToken(tenantId, id);
    const sealedToken = await sealSecret(token, env.VAULT_SECRET);
    await tenantStub.upsertAgentIndex({
      id,
      key,
      tokenHash,
      sealedToken,
      model: opts.model,
      repoId: opts.repoId,
      branch: opts.branch,
      definitionSlug: null,
    });
  }

  await getAgentStub(env, id).initAgent({
    id,
    tenantId,
    key,
    model: opts.model,
    instructions: opts.instructions,
    builtins: opts.builtins,
    repoId: opts.repoId,
    lineage: opts.lineage,
    branch: opts.branch,
  });

  return { id, key };
}
