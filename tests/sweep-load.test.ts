import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientSessions } from "../src/client-sessions.ts";
import type { Session } from "../src/client-sessions/state.ts";

type Loader = {
  sessions: Map<string, Session>;
  loading: Map<string, Promise<Session | undefined>>;
  load(id: string, sweep?: boolean): Promise<Session | undefined>;
  read(id: string, sweep: boolean): Promise<Session | undefined>;
};

function loader(read: Loader["read"]): Loader {
  return Object.assign(Object.create(ClientSessions.prototype), { sessions: new Map(), loading: new Map(), read });
}

test("acting callers joining a declined sweep share a plain retry", async () => {
  const gate = Promise.withResolvers<Session | undefined>();
  const session = {} as Session;
  const calls: boolean[] = [];
  const sessions = loader(async (_id, sweep) => {
    calls.push(sweep);
    return sweep ? gate.promise : session;
  });
  const sweep = sessions.load("agent", true);
  const acting = [sessions.load("agent"), sessions.load("agent")];
  assert.deepEqual(calls, [true]);
  gate.resolve(undefined);
  assert.equal(await sweep, undefined, "a declined sweep still skips the agent");
  assert.deepEqual(await Promise.all(acting), [session, session]);
  assert.deepEqual(calls, [true, false], "acting callers share one load without sweep backoff");
});

test("acting callers reuse a successful shared sweep", async () => {
  const gate = Promise.withResolvers<Session | undefined>();
  const session = {} as Session;
  let reads = 0;
  const sessions = loader(async () => { reads++; return gate.promise; });
  const sweep = sessions.load("agent", true);
  const acting = sessions.load("agent");
  gate.resolve(session);
  assert.equal(await sweep, session);
  assert.equal(await acting, session);
  assert.equal(reads, 1);
});

test("a plain retry after a declined sweep can still return not found", async () => {
  const gate = Promise.withResolvers<Session | undefined>();
  const calls: boolean[] = [];
  const sessions = loader(async (_id, sweep) => { calls.push(sweep); return sweep ? gate.promise : undefined; });
  const sweep = sessions.load("missing", true);
  const acting = sessions.load("missing");
  gate.resolve(undefined);
  await sweep;
  assert.equal(await acting, undefined);
  assert.deepEqual(calls, [true, false]);
});
