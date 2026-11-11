/**
 * Exchange protocol 3: one workflow step, as the workflow runner (host) asks the sandbox Worker for it.
 *
 * Protocol 2 (exchange.ts) runs a code mode script with one RPC per call. A workflow step is one RPC: the host sends
 * the VM's last snapshot (or, without one, every earlier step's results to replay) and this step's new results; the
 * sandbox restores the VM, applies them, runs it until it waits again, and returns the effects it issued, what it
 * logged, how it ended if it did, and a new snapshot. Effects are never run in the sandbox: the host journals them and
 * starts them after its commit.
 *
 * A sandbox from before protocol 3 has no `step` method, which the host reports as such (`stepUnsupported`).
 */
export const WORKFLOW_STEP_PROTOCOL = 3;

/** One step's results, applied in this order, while the VM's clock reads `at`. `value` is the result's JSON. */
export interface WorkflowBatch {
  at: number;
  results: { key: string; ok: boolean; value: string }[];
}

export interface WorkflowStepRequest {
  protocol: typeof WORKFLOW_STEP_PROTOCOL;
  /** The script: the body of an async function that sees the workflow globals. */
  code: string;
  /** The VM's clock at the script's start (ms since the epoch) and its seed; fixed for the workflow's life. */
  startedAt: number;
  seed: number;
  /** The gzipped snapshot the last step returned. Without one the VM starts again and replays `replay`. */
  restore?: Uint8Array;
  /** Without `restore`: every earlier step's results, in step order (none for the workflow's first step). */
  replay?: WorkflowBatch[];
  /** This step's new results. */
  deliver?: WorkflowBatch;
  /** A gzipped snapshot over this many bytes is not returned: the next step replays instead. */
  snapshotCap: number;
}

/** An effect the script asked for. `args` is its canonical JSON; `replayed` ones were issued by a replay. */
export interface IssuedEffect { key: string; kind: string; args: string; phase: string | undefined; replayed: boolean }

/** What the host must handle as a workflow fault: the script cannot go on as written. */
export type WorkflowFaultCode =
  | "key_required" | "key_conflict" | "nondeterministic_script" | "journal_version" | "stalled" | "step_budget";

export type WorkflowStepOutcome =
  | {
    kind: "refused";
    /** The snapshot came from another build or another script; replay instead. */
    reason: "fingerprint" | "script";
    message: string;
  }
  | {
    kind: "ran";
    /** The sandbox's build: the VM, its module, the prelude, this driver, its limits. */
    fingerprint: string;
    /** Whether this step started the VM again and replayed, rather than restoring it. */
    replayed: boolean;
    issued: IssuedEffect[];
    /** Logged during this step's new work (not during a replay). */
    logs: { phase: string | undefined; text: string }[];
    /** The phase the script is in when it waits again. */
    phase: string | undefined;
    done?: { ok: true; value: string | undefined } | { ok: false; error: string };
    fault?: { code: WorkflowFaultCode; message: string };
    /** The new gzipped snapshot: absent once the script ended or faulted, or past `snapshotCap`. */
    snapshot?: Uint8Array;
    snapshotBytes: number;
    polls: number;
    heapBytes: number;
  };

/** The sandbox's side, as its Durable Object exposes it over RPC. */
export interface WorkflowSandbox {
  step(request: WorkflowStepRequest): Promise<WorkflowStepOutcome>;
}
