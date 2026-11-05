import { RemoteCodemodeSandbox, type CodemodeExecuteOptions, type CodemodeRunOptions, type RemoteCodemodeSandboxOptions } from "@earendil-works/pi-codemode/portable";
import { FS_SHIM } from "./fs-shim.ts";
import { SANDBOX_LIMITS } from "../../../src/limits.ts";

/** The shared fs compatibility shim is the only code prepended to stock Pi. */
export class SessionCodemodeSandbox extends RemoteCodemodeSandbox {
  private readonly maxTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  constructor(options: RemoteCodemodeSandboxOptions & { workflow?: boolean }) {
    super({ ...options, remote: () => {
      const remote = options.remote();
      return { execute: (request, exchange) => remote.execute({ ...request, ...(options.workflow ? { workflow: true } : {}) }, exchange) };
    } });
    this.maxTimeoutMs = options.workflow ? SANDBOX_LIMITS.workflowTimeoutMs : SANDBOX_LIMITS.maxTimeoutMs;
    this.defaultTimeoutMs = options.workflow ? SANDBOX_LIMITS.workflowTimeoutMs : SANDBOX_LIMITS.timeoutMs;
  }
  override execute(code: string, options?: CodemodeExecuteOptions) {
    return super.execute(FS_SHIM + code, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs) });
  }
  override start(code: string, options: CodemodeRunOptions) {
    return super.start(FS_SHIM + code, { ...options, timeoutMs: Math.min(options.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs) });
  }
}
