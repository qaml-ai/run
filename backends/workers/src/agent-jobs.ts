// The `jobs` builtin (docs/design/swarm-workflows.md, phase 4, pulled forward after eval #821): an agent runs one shell
// command in a container of its own, through the same JobDriver as a workflow's job(), and waits for it. Without it an
// agent that only needed to run a build wrote a workflow per command. The job is the agent's own: metered computer time
// on its spend limit, its computer tree's slot. On the tenants that have workflows, where a job driver exists (the pilot).
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { jobDriver, type JobDriverEnv } from "./jobs/driver.ts";
import { JOB_LIMITS, JobSpecError, type JobResult, type JobSpec } from "./jobs/job.ts";
import { volume, type FileBindings } from "./files.ts";
import { digest } from "./volume.ts";

export type AgentJobsEnv = JobDriverEnv & FileBindings;

export interface AgentJobsHost {
  env: AgentJobsEnv;
  tenant: string;
  agentId: string;
  /** The agent's storage: a call's result, kept so the call made again (a replay) does not run its command twice. */
  storage: Pick<DurableObjectStorage, "get" | "put">;
}

/** How long job_run waits; a longer job is refused (a workflow's job() can run up to JOB_LIMITS.timeoutSeconds.max). */
export const JOB_RUN_MAX_SECONDS = 900;
/** Of each stream and each output, what the model gets inline: the end of a stream, the start of an output. */
export const JOB_RUN_INLINE_CHARS = 4_000;
const DEFAULT_SECONDS = 300;
const RESULT = "job-run:";

export const JOB_RUN_DESCRIPTION =
  "Run one shell command in a fresh Linux container and wait for it to finish. " +
  "`at` (a volume id) starts it with that volume's files in its working directory (changes are not saved back); `files` gives small files inline instead. " +
  "`outputs` names files the command writes under $JOB_OUT, returned with the result. " +
  "Answers the exit code and the end of stdout and stderr. Use it to build, test or run a script; it is billed as your computer time.";

const decoder = new TextDecoder();
const text = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], structuredOutput: value as never });

/** A call's job id: one per agent and tool call, so a call made again is the same job (its container, its result). */
export async function agentJobId(agentId: string, callId: string) {
  return `agent-${(await digest(new TextEncoder().encode(`${agentId}\n${callId}`))).slice(0, 40)}`;
}

/** What the model reads of a finished job: small, the ends of its streams, the starts of its outputs. */
export function jobRunResult(result: JobResult) {
  if (!result.ok) return { ok: false, code: result.code, error: result.message.slice(0, 2000) };
  const end = (bytes: Uint8Array, size: number) => {
    const all = decoder.decode(bytes);
    return all.length <= JOB_RUN_INLINE_CHARS && size <= bytes.byteLength ? all : `…(${size} bytes; the last ${JOB_RUN_INLINE_CHARS} characters)\n${all.slice(-JOB_RUN_INLINE_CHARS)}`;
  };
  const outputs: Record<string, string> = {};
  for (const [name, output] of Object.entries(result.outputs)) {
    const all = decoder.decode(output.bytes);
    outputs[name] = all.length <= JOB_RUN_INLINE_CHARS && !output.truncated ? all : `${all.slice(0, JOB_RUN_INLINE_CHARS)}\n…(${output.size} bytes; the first ${JOB_RUN_INLINE_CHARS} characters)`;
  }
  return {
    ok: true, exitCode: result.exitCode, timedOut: result.timedOut,
    stdout: end(result.stdout.bytes, result.stdout.size), stderr: end(result.stderr.bytes, result.stderr.size),
    ...(Object.keys(outputs).length ? { outputs } : {}), ...(result.missing.length ? { missing: result.missing } : {}),
    seconds: Math.round(result.timings.totalMs / 100) / 10,
  };
}

/** The builtin's tools, where this deployment has a job driver; none elsewhere. */
export function agentJobTools(host: AgentJobsHost): ToolRegistration[] {
  if (!jobDriver(host.env).ok) return [];
  return [defineTool({
    name: "job_run", description: JOB_RUN_DESCRIPTION, replay: "safe", structuredOutputSchema: {},
    parameters: { type: "object", additionalProperties: false, required: ["command"], properties: {
      command: { type: "string", description: "The shell command (bash -c)" },
      timeoutSeconds: { type: "integer", description: `Kill it after this long, 1 to ${JOB_RUN_MAX_SECONDS} (default ${DEFAULT_SECONDS})` },
      at: { type: "string", description: "A volume id: its files are the working directory" },
      files: { type: "object", additionalProperties: { type: "string" }, description: "Small files, path to text, instead of at" },
      outputs: { type: "array", items: { type: "string" }, description: "Files under $JOB_OUT to return" },
      internet: { type: "boolean", description: "Allow Internet access (off by default)" },
    } } as never,
    execute: async (args: Record<string, unknown>, api) => text(await runJob(host, api.callId, args)),
  })];
}

/** job_run: the call's job, run once (a call made again answers what it answered), its result for the model. */
export async function runJob(host: AgentJobsHost, callId: string, args: Record<string, unknown>) {
  const kept = await host.storage.get<unknown>(RESULT + callId);
  if (kept !== undefined) return kept;
  const found = jobDriver(host.env);
  if (!found.ok) return { ok: false, code: found.code, error: found.message };
  let spec: JobSpec;
  try { spec = await jobRunSpec(host, await agentJobId(host.agentId, callId), args); }
  catch (error) { if (error instanceof JobSpecError || (error as { status?: number }).status === 404) return { ok: false, code: "JOB_INVALID", error: (error as Error).message }; throw error; }
  const result = await found.driver.run(spec);
  // Another run of this call holds its container (the call made again while the first still runs): not a result.
  if (!result.ok && result.code === "job_running") return { ok: false, code: "job_running", error: "This call's job is still running. Wait, then call again." };
  const answer = jobRunResult(result);
  await host.storage.put(RESULT + callId, answer);
  return answer;
}

/** The tool's arguments as a JobSpec, paid by the agent. */
export async function jobRunSpec(host: Pick<AgentJobsHost, "env" | "tenant" | "agentId">, id: string, args: Record<string, unknown>): Promise<JobSpec> {
  if (typeof args.command !== "string" || !args.command.trim()) throw new JobSpecError("command is the shell command to run");
  const seconds = args.timeoutSeconds ?? DEFAULT_SECONDS;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1 || seconds > JOB_RUN_MAX_SECONDS) throw new JobSpecError(`timeoutSeconds is 1 to ${JOB_RUN_MAX_SECONDS}`);
  if (args.at !== undefined && args.files !== undefined) throw new JobSpecError("Give at or files, not both");
  if (args.files !== undefined && (!args.files || typeof args.files !== "object" || Array.isArray(args.files) || Object.values(args.files).some(value => typeof value !== "string")))
    throw new JobSpecError("files maps paths to text");
  if (args.outputs !== undefined && (!Array.isArray(args.outputs) || args.outputs.some(value => typeof value !== "string"))) throw new JobSpecError("outputs is a list of paths");
  let source: Pick<JobSpec, "volume" | "files"> = {};
  if (args.at !== undefined) {
    if (typeof args.at !== "string") throw new JobSpecError("at is a volume id");
    const base = await volume(host.env, host.tenant, args.at);
    const snapshot = await base.snapshot(`job ${id}`, { pinned: true, labels: { agent: host.agentId }, expiresAt: Date.now() + 2 * JOB_RUN_MAX_SECONDS * 1000 + 3_600_000 });
    source = { volume: { tenant: host.tenant, volume: args.at, snapshot: snapshot.id } };
  } else if (args.files) source = { files: Object.fromEntries(Object.entries(args.files as Record<string, string>).map(([path, value]) => [path, new TextEncoder().encode(value)])) };
  return {
    id, command: args.command, timeoutSeconds: Math.ceil(seconds), ...(args.outputs ? { outputs: args.outputs as string[] } : {}),
    ...(args.internet === true ? { internet: true } : {}), ...source, payer: { tenant: host.tenant, agent: host.agentId },
  };
}

export const AGENT_JOB_LIMITS = Object.freeze({ maxSeconds: JOB_RUN_MAX_SECONDS, inlineChars: JOB_RUN_INLINE_CHARS, streamBytes: JOB_LIMITS.streamBytes });
