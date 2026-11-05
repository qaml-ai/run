import { STREAM_TIMEOUTS, type StreamTimeouts } from "./model-stream.ts";

export type ModelTimeoutEnv = {
  AGENT_MODEL_FIRST_TOKEN_SECONDS?: string;
  AGENT_MODEL_IDLE_SECONDS?: string;
};

/** The runtime defaults and validation from src/node-config.ts, without Node configuration loading. */
export function runtimeStreamTimeouts(env: ModelTimeoutEnv): StreamTimeouts {
  const timeouts = {
    firstTokenMs: Number(env.AGENT_MODEL_FIRST_TOKEN_SECONDS ?? STREAM_TIMEOUTS.firstTokenMs / 1000) * 1000,
    idleMs: Number(env.AGENT_MODEL_IDLE_SECONDS ?? STREAM_TIMEOUTS.idleMs / 1000) * 1000,
  };
  for (const [name, ms] of [["AGENT_MODEL_FIRST_TOKEN_SECONDS", timeouts.firstTokenMs], ["AGENT_MODEL_IDLE_SECONDS", timeouts.idleMs]] as const) {
    if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 3_600_000)
      throw new Error(`${name} must be an integer from 1 to 3600`);
  }
  return timeouts;
}
