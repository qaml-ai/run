// `git` as a child process: stdin in, stdout out (Buffer or string), stderr kept for the error.
import { spawn } from "node:child_process";

export const ZERO = "0".repeat(40);

export class GitError extends Error {
  readonly code: number; readonly stdout: Buffer; readonly stderr: string;
  constructor(code: number, stdout: Buffer, stderr: string, args: string[]) {
    super(`git ${args.slice(0, 4).join(" ")}: exit ${code}: ${stderr.trim().slice(0, 300)}`);
    this.code = code; this.stdout = stdout; this.stderr = stderr;
  }
}

type Options = { input?: string | Buffer; env?: Record<string, string>; cwd?: string; okCodes?: number[] };

export function gitRaw(args: string[], options: Options = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: options.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    child.on("close", (code) => {
      const result = { code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() };
      if (code === 0 || options.okCodes?.includes(code ?? -1)) resolve(result);
      else reject(new GitError(result.code, result.stdout, result.stderr, args));
    });
  });
}

export async function git(args: string[], options: Options = {}): Promise<string> {
  return (await gitRaw(args, options)).stdout.toString().trim();
}
