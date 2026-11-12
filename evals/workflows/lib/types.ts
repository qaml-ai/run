import type { Integrity, Sandbox, Score } from "./score.ts";

export type Tier = "S" | "M" | "L" | "N";
/** A task's manifest (`tasks/<id>/task.json`). Only `input/` is ever shown to the agent; `hidden/`, `reference/` and `score.ts` never leave this host. */
export interface Task {
  id: string;
  /** Bump when the input, judge or prompt changes, so results across versions are not compared as one. */
  version: number;
  tier: Tier;
  title: string;
  /** "ready": runnable today. "planned": documented with its sources and judge, not built (Tier M and L). */
  status: "ready" | "planned";
  /** What the agent is asked, verbatim. Model-facing: review wording changes. */
  prompt: string;
  /** The hard cap on what one run may spend, and on its wall time. */
  budget: { usd: number; wallMinutes: number };
  /** Natural units of work (files, tables), for per-unit cost. */
  units: number;
  /** Arguments for the task's reference workflow script (`workflow.js`), in workflow-direct mode. */
  workflowArgs?: Record<string, unknown>;
  /** The task's own judge image directory (a Dockerfile with pinned toolchains), for judges `node:22` cannot run; such a task scores only in docker. */
  judgeImage?: string;
  /** A sentence added to the prompt in workflow mode (e.g. what job() containers have), and in dry mode (its stand-in tools). Model-facing. */
  workflowNote?: string;
  dryNote?: string;
  /** Dry mode's stand-in for `job()`: harness-served build tools for the orchestrator ("go": go_build and go_decode in the judge image). */
  jobs?: string[];
  /** Planned tasks: where the input comes from and how the judge runs. */
  source?: Record<string, unknown>;
  dir: string;
}
export interface ScoreContext { tree: string; input: string; judge: string; sandbox: Sandbox }

/**
 * How a run is orchestrated.
 * - `dry`: what exists today. One agent with `delegate` to worker, critic and lead definitions; no workflow object.
 * - `workflow`: the designed primary interface. The same agent, with the `workflows` builtin it gets with delegate
 *   settings once phase-1 PR 7 lands; whether it writes a workflow is its own choice, and is measured.
 * - `workflow-direct`: the secondary interface. The harness itself starts the task's reference script with
 *   `POST /v1/workflows`, so the runtime is measured apart from the agent's judgment.
 */
export type Mode = "dry" | "workflow" | "workflow-direct";
export type ModelClass = "fast" | "strong";
export type AgentType = "orchestrator" | "worker" | "critic" | "lead" | "other";
export interface Classes { orchestrator: string; worker: string; critic: string; lead: string }

export interface CostBreakdown {
  totalUsd: number;
  byType: Partial<Record<AgentType, number>>;
  /**
   * Output tokens by agent type: who did the writing. Whether the class under test did the work or the orchestrator and
   * critics did it for them (Workers volumes record no writer per change, so this is the measure).
   */
  outputByType: Partial<Record<AgentType, number>>;
  byModel: Record<string, number>;
  /** Cost by model class, from the served model: the fast class's members, the strong class's, anything else. */
  byClass: Partial<Record<ModelClass | "other", number>>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Cached input over all input (cache reads over input + cache reads + cache writes). */
  cacheShare: number;
  responses: number;
}
export interface RunFailure { source: string; message: string; recovered?: boolean }
export interface RunResult {
  schema: 1;
  label: string;
  /** "required": the orchestrator was told to do no item work itself (`--split required`); "free": it chose. */
  split: "free" | "required";
  /** The `--guidance` wording the orchestrator had, by file name; absent: the runtime's own. */
  guidance?: string;
  task: string; taskVersion: number; tier: Tier;
  mode: Mode;
  workerClass: ModelClass;
  classes: Classes;
  run: number;
  /** The runtime's host (never a key). */
  runtime: string;
  startedAt: string;
  wallMs: number;
  /** completed; budget: stopped at the spend cap; timeout: at the wall cap; failed: the agent's run failed; unavailable: the mode needs an API this runtime lacks; error: the harness failed. */
  status: "completed" | "budget" | "timeout" | "failed" | "unavailable" | "error";
  error?: string;
  score: Score | null;
  integrity: Integrity | null;
  cost: CostBreakdown | null;
  budgetUsd: number;
  /** Agents the run made: children of the orchestrator (or the workflow) and their children; effects and jobs in workflow modes. */
  effects: { children: number; grandchildren: number; effects?: number; jobs?: number; failedChildren: number; byStatus: Record<string, number> };
  /** Write conflicts the agents' tools reported, and effects re-run under a new attempt (workflow modes only: dry mode has no attempts to count, so null). */
  conflicts: number;
  retries: number | null;
  /** Whether the orchestrator split the work at all, and how. */
  /** workflowAgents and workflowJobs: the agent() and job() effects across its workflows; a workflow with jobs and no agents was used to run commands, not to split the work. */
  choice: { delegated: boolean; delegateCalls: number; workflowStarted: boolean; workflowIds: string[]; toolCalls: Record<string, number>; workflowAgents?: number; workflowJobs?: number;
    /** Commands run with the job_run builtin (#826), outside any workflow. */
    jobRuns?: number };
  reply?: string;
  /** Runtime failures seen in the run: model errors and retries, failed sub-agents, failed or refused workflow effects, faults. `recovered`: the runtime retried past it. */
  failures?: RunFailure[];
  /** Workflow mode: the <workflow_notification>s the owner got, whether it said something after the last one, and how often it called workflow_status (polling). */
  notifications?: { received: number; events: string[]; replyAfterLast: boolean; statusPolls: number; workflowIds?: string[] };
  /** Set when `run.ts rescore` scored the saved output again with a later judge. */
  rescoredAt?: string;
  /** The orchestrator agent's id (dry and workflow modes), to read its usage and history while the runtime keeps them. */
  agentId?: string;
  /** Where this run's artifacts are (events, output tree). */
  artifacts: string;
}
