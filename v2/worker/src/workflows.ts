import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
  type CodemodeTool,
} from "@earendil-works/pi-codemode/portable";
import { sha256Hex } from "./crypto.ts";
import type { Env } from "./types.ts";

export interface WorkflowHostCallbacks {
  getCachedStep(scope: string, stepKey: string): unknown | undefined;
  putCachedStep(scope: string, stepKey: string, value: unknown): void;
  runAgentStep(prompt: string, opts?: Record<string, unknown>): Promise<unknown>;
  runBashStep(command: string, opts?: Record<string, unknown>): Promise<unknown>;
  runCommitStep(message: string): Promise<unknown>;
  runToolStep(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface WorkflowExecutionSummary {
  workflowId: string;
  scope: string;
  status: "completed" | "failed";
  result: unknown;
  output: unknown;
  logs: string[];
  stepsExecuted: number;
  cachedSteps: number;
  error: { code: string; message: string } | null;
}

export interface WorkflowSandboxConfig {
  env?: Pick<Env, "CODEMODE_SANDBOX">;
  instanceName?: string;
  remote?: () => CodemodeRemote;
  timeoutMs?: number;
  interruptBudget?: number;
  memoryLimitBytes?: number;
}

export async function executeAgentWorkflow(
  workflowId: string,
  scope: string,
  code: string,
  callbacks: WorkflowHostCallbacks,
  sandboxConfig: WorkflowSandboxConfig = {},
): Promise<WorkflowExecutionSummary> {
  let stepSeq = 0;
  let stepsExecuted = 0;
  let cachedSteps = 0;

  const computeStepKey = async (kind: string, payload: unknown): Promise<string> => {
    const idx = stepSeq++;
    const digest = (await sha256Hex(JSON.stringify(payload ?? null))).slice(0, 16);
    return `s${idx}:${kind}:${digest}`;
  };

  const runCached = async <T>(
    kind: string,
    keyPayload: unknown,
    compute: () => Promise<T>,
  ): Promise<T> => {
    const stepKey = await computeStepKey(kind, keyPayload);
    const cached = callbacks.getCachedStep(scope, stepKey);
    if (cached !== undefined) {
      cachedSteps++;
      return cached as T;
    }
    const fresh = await compute();
    callbacks.putCachedStep(scope, stepKey, fresh);
    stepsExecuted++;
    return fresh;
  };

  const resolveRemote = (): CodemodeRemote => {
    if (sandboxConfig.remote) {
      return sandboxConfig.remote();
    }
    const binding = sandboxConfig.env?.CODEMODE_SANDBOX;
    if (!binding) {
      throw new Error(
        "CODEMODE_SANDBOX Durable Object binding is not configured on this Worker",
      );
    }
    return binding.getByName(
      sandboxConfig.instanceName || `workflow:${workflowId}`,
    ) as unknown as CodemodeRemote;
  };

  const wfHostGlobal: CodemodeTool = {
    name: "__wfHostCall",
    spread: true,
    async execute(rawArgs: unknown): Promise<unknown> {
      const tuple = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
      const op = String(tuple[0] ?? "");
      const payload =
        tuple[1] && typeof tuple[1] === "object" && !Array.isArray(tuple[1])
          ? (tuple[1] as Record<string, unknown>)
          : {};

      if (op === "wf:agent") {
        const prompt = String(payload.prompt ?? "");
        const opts =
          payload.opts && typeof payload.opts === "object"
            ? (payload.opts as Record<string, unknown>)
            : {};
        return runCached("agent", { prompt, opts }, () => callbacks.runAgentStep(prompt, opts));
      }

      if (op === "wf:bash") {
        const command = String(payload.command ?? "");
        const opts =
          payload.opts && typeof payload.opts === "object"
            ? (payload.opts as Record<string, unknown>)
            : {};
        return runCached("bash", { command, opts }, () => callbacks.runBashStep(command, opts));
      }

      if (op === "wf:commit") {
        const message = String(payload.message ?? "workflow checkpoint");
        return runCached("commit", { message }, () => callbacks.runCommitStep(message));
      }

      if (op === "wf:sleep") {
        const ms = Math.max(0, Math.min(10_000, Number(payload.ms ?? 0)));
        return runCached("sleep", { ms }, async () => {
          if (ms > 0) {
            await new Promise((r) => setTimeout(r, Math.min(ms, 2_000)));
          }
          return { sleptMs: ms };
        });
      }

      if (op === "wf:tool") {
        const name = String(payload.name ?? "");
        const args =
          payload.args && typeof payload.args === "object"
            ? (payload.args as Record<string, unknown>)
            : {};
        return runCached(`tool:${name}`, { name, args }, () => callbacks.runToolStep(name, args));
      }

      if (op === "wf:step_check") {
        const name = String(payload.name ?? "step");
        const stepKey = await computeStepKey("custom", { name });
        const existing = callbacks.getCachedStep(scope, stepKey);
        if (existing !== undefined) {
          cachedSteps++;
          return { found: true, stepKey, value: existing };
        }
        return { found: false, stepKey };
      }

      if (op === "wf:step_save") {
        const stepKey = String(payload.key ?? "");
        callbacks.putCachedStep(scope, stepKey, payload.value ?? null);
        stepsExecuted++;
        return { saved: true };
      }

      throw new Error(`Unknown workflow host op: ${op}`);
    },
  };

  const wrappedCode = `
const wf = {
  agent: (prompt, opts = {}) => __wfHostCall("wf:agent", { prompt: String(prompt), opts }),
  bash: (command, opts = {}) => __wfHostCall("wf:bash", { command: String(command), opts }),
  commit: (message = "workflow checkpoint") => __wfHostCall("wf:commit", { message: String(message) }),
  sleep: (ms = 0) => __wfHostCall("wf:sleep", { ms: Number(ms) || 0 }),
  tool: (name, args = {}) => __wfHostCall("wf:tool", { name: String(name), args }),
  step: async (name, fn) => {
    const hit = await __wfHostCall("wf:step_check", { name: String(name) });
    if (hit && hit.found) return hit.value;
    const val = await fn();
    await __wfHostCall("wf:step_save", { key: hit.stepKey, value: val });
    return val;
  },
  parallel: async (tasks) => {
    if (!Array.isArray(tasks)) throw new Error("wf.parallel expects an array");
    const promises = tasks.map((item, idx) => {
      if (typeof item === "function") {
        return Promise.resolve().then(() => item(idx));
      }
      if (typeof item === "string") {
        return wf.agent(item);
      }
      if (item && typeof item === "object" && "prompt" in item) {
        return wf.agent(item.prompt, item);
      }
      return Promise.resolve(item);
    });
    return Promise.all(promises);
  },
};
return await (async () => {
${code}
})();
`;

  try {
    const sandbox = new RemoteCodemodeSandbox({
      remote: resolveRemote,
      globals: [wfHostGlobal],
      timeoutMs: sandboxConfig.timeoutMs ?? 120_000,
      interruptBudget: sandboxConfig.interruptBudget ?? 1_000_000,
      memoryLimitBytes: sandboxConfig.memoryLimitBytes ?? 32 * 1024 * 1024,
    });

    const outcome = await sandbox.execute(wrappedCode);
    const logs = outcome.output
      .filter((item): item is { type: "text"; text: string; console?: true } => item.type === "text")
      .map((item) => item.text);

    if (!outcome.ok) {
      return {
        workflowId,
        scope,
        status: "failed",
        result: null,
        output: null,
        logs,
        stepsExecuted,
        cachedSteps,
        error: { code: "workflow_failed", message: outcome.error.message },
      };
    }

    return {
      workflowId,
      scope,
      status: "completed",
      result: outcome.value ?? null,
      output: outcome.value ?? null,
      logs,
      stepsExecuted,
      cachedSteps,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      workflowId,
      scope,
      status: "failed",
      result: null,
      output: null,
      logs: [],
      stepsExecuted,
      cachedSteps,
      error: { code: "workflow_failed", message },
    };
  }
}
