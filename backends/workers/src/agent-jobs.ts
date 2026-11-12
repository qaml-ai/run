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
  storage: Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;
  /** The run a tool call belongs to: a model's call ids repeat across runs (`call_0`), so a call is named by both. */
  runId(api: unknown): Promise<string>;
}

/** How long job_run waits; a longer job is refused (a workflow's job() can run up to JOB_LIMITS.timeoutSeconds.max). */
export const JOB_RUN_MAX_SECONDS = 900;
/** Of each stream and each output, what the model gets inline: the end of a stream, the start of an output. */
export const JOB_RUN_INLINE_CHARS = 4_000;
const DEFAULT_SECONDS = 300;
const RESULT = "job-run:";
/** The run id of a turn no request started (agent-turn-loop.ts currentRun). */
export const BACKGROUND_RUN = "background";
/** How long a call's answer is kept for a replay of it; older ones are pruned as later calls run. */
export const JOB_RUN_KEPT_MS = 86_400_000;
type Kept = { answer: unknown; at: number };

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
    execute: async (args: Record<string, unknown>, api) => {
      const run = await host.runId(api);
      // A call outside any request (the runtime's own background turn, "background") has no run to name its job by: the
      // model's call ids repeat, so another background turn's job would answer it. Refused, never run.
      if (run === BACKGROUND_RUN) return text({ ok: false, code: "JOB_UNAVAILABLE", error: "job_run runs only within a request; ask again from a prompt" });
      return text(await runJob(host, `${run}:${api.callId}`, args));
    },
  })];
}

/** job_run: the call's job (`callId` names it: the run's id and the model's call id), run once (a call made again answers what it answered), its result for the model. */
export async function runJob(host: AgentJobsHost, callId: string, args: Record<string, unknown>) {
  const kept = await host.storage.get<Kept>(RESULT + callId);
  if (kept !== undefined) return kept.answer;
  const found = jobDriver(host.env);
  if (!found.ok) return { ok: false, code: found.code, error: found.message };
  let spec: JobSpec;
  try { spec = await jobRunSpec(host, await agentJobId(host.agentId, callId), args); }
  catch (error) { if (error instanceof JobSpecError || (error as { status?: number }).status === 404) return { ok: false, code: "JOB_INVALID", error: (error as Error).message }; throw error; }
  // The call's job, by its id: made again (this agent was evicted mid-call), it waits for the run already going, or gets
  // the result that run kept, from the job's container object: one run, one charge (jobs/objects runJob).
  const result = await found.driver.run(spec);
  const answer = jobRunResult(result);
  if (!result.ok && result.code === "job_running") return answer; // not this call's job (never kept as its answer)
  const now = Date.now();
  await host.storage.put(RESULT + callId, { answer, at: now } satisfies Kept);
  for (const [key, old] of await host.storage.list<Kept>({ prefix: RESULT })) if (now - (old?.at ?? 0) > JOB_RUN_KEPT_MS) await host.storage.delete(key);
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
