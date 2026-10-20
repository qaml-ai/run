// Measurement-only preload: attribute instrumented branches in descendants to their test file,
// including servers whose fixtures deliberately replace the environment.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
if (process.argv[1]?.endsWith(".test.ts")) process.env.TEST_MODE_OWNER = basename(process.argv[1]);
const original = childProcess.spawn;
childProcess.spawn = ((command: string, args: string[], options: any) => original(command, args, options?.env ? {
  ...options, env: { ...options.env, TEST_MODE_OWNER: process.env.TEST_MODE_OWNER, TEST_MODE_TRACE_DIR: process.env.TEST_MODE_TRACE_DIR },
} : options)) as typeof original;
syncBuiltinESMExports();
