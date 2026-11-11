import { test } from "node:test";
import assert from "node:assert/strict";
import { Computers } from "../src/computers/service.ts";
import type { ManagedMachines } from "../src/computers/managed.ts";
import { makeChild, type DelegationContext } from "../src/client-sessions/delegation.ts";
import { HttpError } from "../src/http.ts";
import { Outbound } from "../src/outbound.ts";
import { boundedStart, computerChoice, forkBatch, forkTargets, FORK_LIMITS } from "../src/core/computer-fork.ts";
import { family, fixture, HOUR } from "./computers-fixture.ts";
import { fakeBoatServer } from "./fake-boat.ts";

const exec = (service: Computers, agent: string, command: string, key = `${agent}-${command}`) => service.call("payg", agent, "computer_exec", { command }, key) as Promise<{ exitCode: number; stdout: string }>;
const start = (service: Computers, agent: string) => service.call("payg", agent, "computer_start", {}, `start-${agent}-${Math.random()}`);
const refused = (code: string) => (error: unknown) => (error as HttpError).status === 409 && (error as HttpError).code === code;

test("a managed Boat fork copies the parent's disk; each fork's writes stay its own; one snapshot serves every agent of a call", async () => {
  const f = await fixture({ extraAgents: ["c1", "c2"] });
  await f.connect();
  await start(f.service, "a");
  await exec(f.service, "a", "put notes parent-v1");
  const forked = await f.service.forkInto("payg", { agent: "a" }, ["c1", "c2"]);
  assert.equal(f.state.taken.length, 1, "one snapshot for both");
  assert.equal(forked.forks.length, 2);
  for (const fork of forked.forks) assert.deepEqual(fork.forkedFrom, { agent: "a", connection: (await f.service.status("payg", "a")).connection.id, snapshot: forked.snapshot.id, provider: "boat", at: forked.snapshot.createdAt });
  // The parent writes after the fork: the forks still see the disk as it was at the fork.
  await exec(f.service, "a", "put notes parent-v2");
  await start(f.service, "c1");
  await start(f.service, "c2");
  assert.equal((await exec(f.service, "c1", "get notes")).stdout, "parent-v1");
  await exec(f.service, "c1", "put notes c1");
  await exec(f.service, "c1", "put mine c1");
  assert.equal((await exec(f.service, "c2", "get notes")).stdout, "parent-v1", "a sibling's writes never reach another fork");
  assert.equal((await exec(f.service, "c2", "get mine")).exitCode, 1);
  assert.equal((await exec(f.service, "a", "get notes", "a-after")).stdout, "parent-v2", "a fork's writes never reach the parent");
  assert.equal((await exec(f.service, "a", "get mine", "a-mine")).exitCode, 1);
  // Each fork is its own managed session, billed as any.
  assert.equal((await f.db.query("select count(*)::int as n from managed_computers where agent in ('c1','c2') and machine is not null")).rows[0].n, 2);
  // The snapshot goes with the last connection that starts from it, once siblings of its call had time to attach.
  await f.service.removeAgent("payg", "c1");
  f.advance(FORK_LIMITS.dropGraceMs + 1);
  await f.service.removeAgent("payg", "c2");
  assert.deepEqual(f.state.dropped, [f.state.taken[0]]);
  assert.ok((await f.db.query("select dropped_at from computer_snapshots where id=$1", [forked.snapshot.id])).rows[0].dropped_at);
  f.done();
});

test("one call's children share its snapshot, a new call takes a new one, and a snapshot no child attached to is dropped by the sweep", async () => {
  const f = await fixture();
  await f.connect();
  await start(f.service, "a");
  const first = await f.service.forkSnapshot("payg", "a", forkBatch("run", 3, "call_1"));
  const again = await f.service.forkSnapshot("payg", "a", forkBatch("run", 3, "call_2"));
  assert.equal(again.id, first.id, "calls of one response share it");
  // Siblings of one response made at once: one wins the batch's row and takes the snapshot, the others wait for it.
  const together = await Promise.all([1, 2, 3, 4].map(n => f.service.forkSnapshot("payg", "a", forkBatch("run", 4, `call_${n}`))));
  assert.equal(new Set(together.map(snapshot => snapshot.id)).size, 1);
  const later = await f.service.forkSnapshot("payg", "a", forkBatch("run", 5, "call_3"));
  assert.notEqual(later.id, first.id);
  assert.equal(f.state.taken.length, 3);
  await f.service.sweep();
  assert.deepEqual(f.state.dropped, [], "kept through the grace, while siblings may still attach");
  f.advance(FORK_LIMITS.dropGraceMs + 1);
  await f.service.sweep();
  assert.equal(f.state.dropped.length, 3);
  // A drop that keeps failing backs off and is given up after its last attempt, so it never blocks newer ones.
  const stuck = await f.service.forkSnapshot("payg", "a", forkBatch("run", 6, "call_4"));
  f.advance(FORK_LIMITS.dropGraceMs + 1);
  const drop = f.service.managed.dropSnapshot;
  f.service.managed.dropSnapshot = async () => { throw new Error("provider down"); };
  for (let attempt = 0; attempt < 10; attempt++) { await f.service.sweep(); f.advance(6 * HOUR + 1); }
  f.service.managed.dropSnapshot = drop;
  const row = (await f.db.query("select dropped_at, attempts, error from computer_snapshots where id=$1", [stuck.id])).rows[0];
  assert.ok(row.dropped_at);
  assert.equal(row.attempts, 10);
  assert.match(row.error, /^gave up/);
  f.done();
});

test("a fork needs a running session, and is refused by providers that cannot copy a disk", async () => {
  const f = await fixture({ extraAgents: ["l"] });
  await f.connect();
  await assert.rejects(f.service.forkSnapshot("payg", "a", "batch"), refused("NO_SESSION"));
  await assert.rejects(f.service.forkSnapshot("payg", "b", "batch"), refused("NO_SESSION"), "no computer at all");
  // Bring your own E2B: its driver has no snapshot, so the call fails before any session is asked for.
  await f.service.create("payg", { agent: "b", provider: "e2b", credentials: { apiKey: "fixture" } });
  await assert.rejects(f.service.forkSnapshot("payg", "b", "batch"), refused("FORK_UNSUPPORTED"));
  // Managed Lambda MicroVMs: no snapshot to start another machine from.
  const lambda: ManagedMachines = { async create() { return { id: "vm" }; }, async extend() {}, async remove() {}, async list() { return []; }, async run() { return { exitCode: 0, stdout: "", stderr: "", truncated: false }; } };
  const onLambda = new Computers({ provider: "lambda", db: f.db, accounts: f.accounts, outbound: new Outbound(), enabled: true, runtime: "https://run.test", machines: () => lambda });
  await onLambda.create("payg", { agent: "l", provider: "lambda" });
  await assert.rejects(onLambda.forkSnapshot("payg", "l", "batch"), refused("FORK_UNSUPPORTED"));
  assert.equal(f.state.taken.length, 0);
  f.done();
});

test("delegate and spawn_agent children: a fork's seed starts the child's sessions from the snapshot, none attaches nothing", async t => {
  const f = await family(t, true);
  await start(f.service, f.parent);
  await exec(f.service, f.parent, "put repo cloned");
  const snapshot = await f.service.forkSnapshot("payg", f.parent, forkBatch("run", 1, "call"));
  const ctx = (f.sessions as unknown as { delegationContext: DelegationContext }).delegationContext;
  const make = (key: string, computer?: "none" | { seed: string }) => makeChild(ctx, f.sessions.sessions.get(f.parent)!, { id: "run" } as Parameters<typeof makeChild>[2], undefined, key, key, { depth: 1, maxDepth: 1, chain: [f.parent] }, computer);
  const forked = await make("forked", { seed: snapshot.id });
  const status = await f.service.status("payg", forked);
  assert.equal(status.connection.forkedFrom?.snapshot, snapshot.id);
  await start(f.service, forked);
  assert.equal((await exec(f.service, forked, "get repo")).stdout, "cloned");
  const none = await make("none", "none");
  await assert.rejects(f.service.status("payg", none), (error: HttpError) => error.status === 404);
  const fresh = await make("fresh");
  assert.equal((await f.service.status("payg", fresh)).connection.forkedFrom, undefined);
  // A delegate child's work ends: its session stops, its connection stays.
  await f.service.release("payg", forked);
  assert.equal((await f.service.status("payg", forked)).session?.state, "closed");
});

test("bring-your-own Boat forks through saved snapshots on the provider account", async t => {
  const boat = await fakeBoatServer();
  t.after(() => boat.close());
  const f = await fixture();
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  const service = new Computers({ db: f.db, accounts: f.accounts, outbound, enabled: true, runtime: "https://run.test", boatUrl: boat.url });
  // Its own Boat account takes snapshots only when the connection asks to be forkable.
  await service.create("payg", { agent: "a", provider: "boat", credentials: { apiKey: "byo-key" }, leaseSeconds: 600, dailySeconds: 3600, forkable: true });
  await service.call("payg", "a", "computer_start", {}, "start-a");
  assert.equal((await exec(service, "a", "echo parent > notes.txt && mkdir -p src && echo built > src/out")).exitCode, 0);
  const forked = await service.forkInto("payg", { agent: "a" }, ["b"]);
  assert.deepEqual(boat.state.snapshots, [`camelrun-${forked.snapshot.id}`]);
  await service.call("payg", "b", "computer_start", {}, "start-b");
  assert.equal([...boat.state.sandboxes.values()].filter(box => box.from).length, 1, "made from the saved snapshot");
  assert.equal((await exec(service, "b", "cat notes.txt src/out")).stdout, "parent\nbuilt\n");
  await exec(service, "b", "echo child > notes.txt");
  assert.equal((await exec(service, "a", "cat notes.txt", "a-read")).stdout, "parent\n");
  assert.deepEqual([...boat.state.keys], ["byo-key"], "the provider account's key, and only it");
  await service.removeAgent("payg", "b");
  assert.deepEqual(boat.state.dropped, [], "kept through the grace");
  await service.removeTenant("payg");
  assert.deepEqual(boat.state.dropped, [`camelrun-${forked.snapshot.id}`], "an account deletion drops it whatever the grace");
  assert.equal(boat.state.sandboxes.size, 0);
  // Without forkable, an own Boat account's machines take no snapshots, and a fork says how to turn it on.
  await service.create("payg", { agent: "a", provider: "boat", credentials: { apiKey: "byo-key" }, leaseSeconds: 600, dailySeconds: 3600 });
  await service.call("payg", "a", "computer_start", {}, "start-plain");
  await assert.rejects(service.forkSnapshot("payg", "a", "plain"), (error: HttpError) => error.code === "FORK_UNSUPPORTED" && error.details?.reason === "not_forkable");
  await service.removeTenant("payg");
  f.done();
});

test("the shared fork policy: choices, batches, route input and a bounded start with one retry", async () => {
  assert.equal(computerChoice(undefined), "share", "left out, a sub-agent shares its parent computer when present");
  assert.equal(computerChoice(null, true), "fresh", "left out, a definition that declares a computer keeps it");
  assert.equal(computerChoice("fresh"), "fresh");
  assert.equal(computerChoice("none", true), "none");
  assert.equal(computerChoice("fork"), "fork");
  assert.throws(() => computerChoice("copy"), (error: HttpError) => error.status === 400);
  assert.equal(forkBatch("r", 2, "c"), "r:m2");
  assert.equal(forkBatch("r", undefined, "c"), "r:cc");
  assert.deepEqual(forkTargets({ agents: ["x", "y"] }, "a"), ["x", "y"]);
  assert.deepEqual(forkTargets({ agent: "x" }, "a"), ["x"]);
  for (const bad of [{}, { agents: [] }, { agents: ["x", "x"] }, { agents: ["a"] }, { agents: ["x"], agent: "y" }, { agents: Array.from({ length: 17 }, (_, i) => `x${i}`) }, { count: 2 }])
    assert.throws(() => forkTargets(bad, "a"), (error: HttpError) => error.status === 400, JSON.stringify(bad));
  let tries = 0, undone = 0;
  assert.equal(await boundedStart(async (_signal, index) => { tries++; if (index === 0) await new Promise(resolve => setTimeout(resolve, 200)); return "up"; }, { waitMs: 50, onTimeout: async () => { undone++; } }), "up");
  assert.deepEqual([tries, undone], [2, 1]);
  await assert.rejects(boundedStart(() => new Promise(resolve => setTimeout(resolve, 200)), { waitMs: 20 }), (error: HttpError) => error.status === 503 && error.code === "COMPUTER_STARTING");
  await assert.rejects(boundedStart(async () => { throw new Error("over limits"); }, { waitMs: 50 }), /over limits/, "a failure is not retried");
});

test("sharing keeps one managed connection, owner billing, idle activity and grandchildren", async t => {
  const f = await fixture({ extraAgents: ["child", "grandchild", "empty"] });
  t.after(f.done);
  await f.connect();
  await start(f.service, "a");
  await f.service.inherit("payg", "a", "child", f.db, "share");
  await f.service.inherit("payg", "child", "grandchild", f.db, "share");
  await f.service.inherit("payg", "empty", "b", f.db, "share");
  await assert.rejects(f.service.status("payg", "b"), /No computer/);
  await exec(f.service, "a", "put shared parent");
  assert.equal((await exec(f.service, "grandchild", "get shared")).stdout, "parent");
  await exec(f.service, "child", "put shared child");
  assert.equal((await exec(f.service, "a", "get shared")).stdout, "child");
  for (const name of ["computer_start", "computer_stop"]) await assert.rejects(f.service.call("payg", "child", name, {}, name), /belongs to your parent agent/);
  const deadline = Number((await f.row()).deadline);
  f.advance(4_000_000);
  await exec(f.service, "grandchild", "get shared", "keep-alive");
  assert.ok(Number((await f.row()).deadline) > deadline, "child activity extends the owner idle deadline");
  const owner = await f.service.status("payg", "a");
  assert.equal((await f.service.status("payg", "grandchild")).session!.id, owner.session!.id);
  await f.service.release("payg", "child");
  await f.service.removeAgent("payg", "child");
  assert.equal((await f.service.status("payg", "a")).session!.state, "active");
  const rows = (await f.db.query("select agent from managed_computers")).rows;
  assert.deepEqual(rows.map(row => row.agent), ["a"]);
  assert.equal((await f.service.list("payg")).length, 1);
});

test('tree computer cap admits concurrent starts atomically and releases stopped capacity', async t => {
  const f = await fixture({ extraAgents: ['c1', 'c2'] });
  t.after(f.done);
  await f.db.query("update agents set header=header::jsonb || $2::jsonb where id=$1", ['a', JSON.stringify({ config: { computerLimit: 2 } })]);
  for (const child of ['c1', 'c2']) await f.db.query("update agents set header=header::jsonb || $2::jsonb where id=$1", [child, JSON.stringify({ parent: { agentId: 'a' } })]);
  await f.connect();
  for (const child of ['c1', 'c2']) await f.service.inherit('payg', 'a', child, f.db);
  await start(f.service, 'a');
  const results = await Promise.allSettled(['c1', 'c2'].map(child => start(f.service, child)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const refusedResult = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(refusedResult.reason.message, /Use computer "share" for new sub-agents/);
  const winner = ['c1', 'c2'][results.findIndex(result => result.status === 'fulfilled')];
  const loser = ['c1', 'c2'][results.findIndex(result => result.status === 'rejected')];
  await f.service.release('payg', winner);
  await start(f.service, loser);
  assert.equal((await f.service.status('payg', loser)).session!.state, 'active');
});

test('the tree root is read as stored (rootOwner, else the chain older nodes stored), never walked', async t => {
  // Three generations under root 'a' (limit 1). The grandchild's header names its root directly and its parent's row is
  // gone, as a walk would need it; the other child is shaped as an older node wrote it (parent.chain, no rootOwner).
  const f = await fixture({ extraAgents: ['old-child', 'grandchild'] });
  t.after(f.done);
  await f.db.query("update agents set header=header::jsonb || $2::jsonb where id=$1", ['a', JSON.stringify({ config: { computerLimit: 1 } })]);
  await f.db.query("update agents set header=header::jsonb || $2::jsonb where id=$1", ['grandchild', JSON.stringify({ parent: { agentId: 'deleted-middle' }, owner: { kind: 'agent', id: 'deleted-middle' }, rootOwner: { kind: 'agent', id: 'a' } })]);
  await f.db.query("update agents set header=header::jsonb || $2::jsonb where id=$1", ['old-child', JSON.stringify({ parent: { agentId: 'a', chain: ['a'] } })]);
  await f.connect();
  await f.connect('payg', 'grandchild');
  await f.connect('payg', 'old-child');
  await start(f.service, 'grandchild');
  const slot = (await f.db.query("select s.root from computer_slots s join computer_connections c on c.id=s.machine where c.agent='grandchild'")).rows[0];
  assert.equal(slot.root, 'a');
  // The tree's one machine is taken: the root's own start and the older-shaped child's are refused alike.
  await assert.rejects(start(f.service, 'a'), /concurrent computer limit|Use computer "share"/);
  await assert.rejects(start(f.service, 'old-child'), /concurrent computer limit|Use computer "share"/);
});

test('managed starts never list other machines, and expired sharing calls fail without blocking their owner', async t => {
  const f = await fixture({ extraAgents: ['child'] }); t.after(f.done);
  const service = new Computers({ ...f.service.options, provider: 'lambda' });
  f.state.listFails = true;
  await service.create('payg', { agent: 'a', provider: 'lambda' });
  await start(service, 'a');
  await service.inherit('payg', 'a', 'child', f.db, 'share');
  await f.db.query('update managed_computers set deadline=$1', [1]);
  const calls = f.state.runs.length;
  await assert.rejects(exec(service, 'child', 'true'), /parent's machine is stopped.*Finish your task and report back/);
  assert.equal(f.state.runs.length, calls);
  f.state.listFails = false;
  f.advance(1);
  await start(service, 'a');
  assert.equal((await service.status('payg', 'a')).session!.state, 'active');
});


test("expired BYO sharing calls fail before cleanup and leave the owner free to restart", async t => {
  const boat = await fakeBoatServer(); t.after(() => boat.close());
  const f = await fixture({ extraAgents: ["child"] }); t.after(f.done);
  const service = new Computers({ db: f.db, accounts: f.accounts, outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }), enabled: true, runtime: "https://run.test", boatUrl: boat.url });
  await service.create("payg", { agent: "a", provider: "boat", credentials: { apiKey: "byo-key" }, leaseSeconds: 600, dailySeconds: 3600 });
  await start(service, "a");
  await service.inherit("payg", "a", "child", f.db, "share");
  await f.db.query("update computer_leases set expires_at=1");
  await assert.rejects(exec(service, "child", "true"), /parent's machine is stopped.*Finish your task and report back/);
  assert.equal(boat.state.sandboxes.size, 1, "a sharer does not stop the expired owner machine");
  await start(service, "a");
  assert.equal((await service.status("payg", "a")).session!.state, "active");
});


test("slot admission reconciles only ended rows in its own tree without provider listing", async t => {
  const f = await fixture({ extraAgents: ["ended", "unrelated"] }); t.after(f.done);
  await f.db.query("update agents set header=$1 where id='a'", [JSON.stringify({ config: { computerLimit: 1 } })]);
  await f.db.query("update agents set header=$1 where id='ended'", [JSON.stringify({ parent: { agentId: "a" } })]);
  await f.connect();
  await f.connect("payg", "ended");
  await f.connect("payg", "unrelated");
  await start(f.service, "ended");
  await start(f.service, "unrelated");
  await f.db.query("update managed_computers set ended_at=$1 where agent in ('ended','unrelated')", [f.now() + 1]);
  const before = (await f.db.query("select s.* from computer_slots s join computer_connections c on c.id=s.machine where c.agent='unrelated'")).rows[0];
  f.state.listFails = true;
  await start(f.service, "a");
  assert.equal((await f.service.status("payg", "a")).session!.state, "active");
  const after = (await f.db.query("select s.* from computer_slots s join computer_connections c on c.id=s.machine where c.agent='unrelated'")).rows[0];
  assert.deepEqual(after, before, "admission leaves another root's slots alone");
});
