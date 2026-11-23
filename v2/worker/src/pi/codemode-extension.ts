/**
 * Remote isolated codemode extension for CamelRun v2 (`camelrun-v2-prod`).
 *
 * INVARIANT: This module MUST ONLY import `RemoteCodemodeSandbox` from
 * `@earendil-works/pi-codemode/portable`. It MUST NEVER import
 * `@earendil-works/pi-codemode/cloudflare` or `quickjs-wasi`, ensuring that
 * `quickjs.wasm` (623 KiB) stays exclusively inside the dedicated
 * `camelrun-v2-codemode-sandbox` Worker.
 */
import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
} from "@earendil-works/pi-codemode/portable";
import {
  createCodemodeExtension,
  type CodemodeGlobal,
} from "@earendil-works/pi-durable/codemode";
import type { Extension } from "@earendil-works/pi-durable";
import type { Env } from "../types.ts";

export const DEFAULT_CODEMODE_INTERRUPT_BUDGET = 500_000;
export const DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CODEMODE_TIMEOUT_MS = 30_000;

export interface CamelRunCodemodeOptions {
  /** Worker env carrying the `CODEMODE_SANDBOX` cross-worker Durable Object binding. */
  env?: Pick<Env, "CODEMODE_SANDBOX">;
  /** Durable Object instance name (e.g. `${agentId}:${conversationId}`), or factory returning it. */
  instanceName?: string | (() => string);
  /**
   * Optional remote stub factory (e.g. for Miniflare multi-worker or in-process tests).
   * When omitted, resolves `env.CODEMODE_SANDBOX.getByName(instanceName)`.
   */
  remote?: () => CodemodeRemote;
  /** Interrupt polls budget per script execution (default 500,000). */
  interruptBudget?: number;
  /** Maximum execution wall-clock timeout in milliseconds (default 30,000). */
  timeoutMs?: number;
  /** Maximum QuickJS heap memory in bytes (default 32 MiB). */
  memoryLimitBytes?: number;
  /** Estimated token budget for inline tool declarations in the `codemode` prompt section. */
  inlineBudget?: number;
  /** Whether to expose `models.*` inside codemode scripts (default `false`). */
  models?: boolean;
  /** Optional host globals exposed to scripts. */
  globals?: readonly CodemodeGlobal[];
}

export function createCamelRunCodemodeSandbox(
  options: CamelRunCodemodeOptions,
): RemoteCodemodeSandbox {
  const resolveRemote = (): CodemodeRemote => {
    if (options.remote) {
      return options.remote();
    }
    const binding = options.env?.CODEMODE_SANDBOX;
    if (!binding) {
      throw new Error(
        "CODEMODE_SANDBOX Durable Object binding is not configured on this Worker",
      );
    }
    const name =
      typeof options.instanceName === "function"
        ? options.instanceName()
        : options.instanceName || "default";
    return binding.getByName(name) as unknown as CodemodeRemote;
  };

  return new RemoteCodemodeSandbox({
    remote: resolveRemote,
    interruptBudget: options.interruptBudget ?? DEFAULT_CODEMODE_INTERRUPT_BUDGET,
    timeoutMs: options.timeoutMs ?? DEFAULT_CODEMODE_TIMEOUT_MS,
    memoryLimitBytes: options.memoryLimitBytes ?? DEFAULT_CODEMODE_MEMORY_LIMIT_BYTES,
  });
}

export function createCamelRunCodemodeExtension(
  options: CamelRunCodemodeOptions,
): Extension {
  const sandbox = createCamelRunCodemodeSandbox(options);
  return createCodemodeExtension({
    sandbox,
    models: options.models ?? false,
    ...(options.inlineBudget !== undefined ? { inlineBudget: options.inlineBudget } : {}),
    ...(options.globals ? { globals: options.globals } : {}),
  });
}
