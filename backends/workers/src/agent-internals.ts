/** Internal subclass capability. Symbols cannot be addressed by Durable Object RPC. */
export const ARM_AGENT = Symbol("camelRun.armAgent");
/** Bring pending human inputs' expiry forward (the local contract fixture's due inputs). */
export const DUE_HUMAN_INPUTS = Symbol("camelRun.dueHumanInputs");

/** A server-verified member prompt. A symbol keeps it off the Durable Object RPC surface. */
export const SUBMIT_SHARED_PROMPT = Symbol("submit-shared-prompt");

/** Test-only observation through a subclass; never an RPC method. */
export const SHARED_ADMISSION_STATE = Symbol("shared-admission-state");
