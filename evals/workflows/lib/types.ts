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
  byModel: Record<string, number>;
  /** Cost by model class, from the served model: the fast class's members, the strong class's, anything else. */
  byClass: Partial<Record<ModelClass | "other", number>>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Cached input over all input (cache reads over input + cache reads + cache writes). */
  cacheShare: number;
  responses: number;
}
export interface RunResult {
  schema: 1;
  label: string;
  /** "required": the orchestrator was told to do no item work itself (`--split required`); "free": it chose. */
  split: "free" | "required";
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
  choice: { delegated: boolean; delegateCalls: number; workflowStarted: boolean; workflowIds: string[]; toolCalls: Record<string, number> };
  reply?: string;
  /** Where this run's artifacts are (events, output tree). */
  artifacts: string;
}
