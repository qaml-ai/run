import { Directory, type ControlEnv } from "./control.ts";

/** Upserts and explicit configuration requests share the same durable ordering. */
export async function upsertAgent(env: ControlEnv, tenant: string, input: Record<string, unknown>, key: string | undefined, origin: string) {
  return { entry: await new Directory(env, tenant).upsert(input, key, origin, undefined, true) };
}
