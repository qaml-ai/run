import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.ts';
import { deliverScheduleEmail, type ScheduleEnv } from '../src/schedules.ts';

test('schedule mail bounds reads, retries and concurrent sends against local SQL and a fake mail binding', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  let read: (request: Request) => Promise<Response> = async () => Response.json({ state: 'completed', outcome: { result: { reply: '**Synthetic report**' } } });
  let send: (mail: any) => Promise<{ messageId: string }> = async () => ({ messageId: 'fake-message' });
  const env: ScheduleEnv = {
    HYPERDRIVE: { connectionString: fixture.databaseUrl }, API_TOKEN: fixture.token,
    SCHEDULE_EMAIL_FROM: 'reports@example.test', SCHEDULE_OPERATOR_TENANTS: 'camelrun-proto-local',
    AGENTS: { getByName: () => ({ fetch: request => read(request) }) },
    MAIL: { send: mail => send(mail) },
  };
  const insert = async (id: string, createdAt = Date.now()) => {
    await fixture.db.query('insert into schedule_deliveries(id,tenant,agent,schedule,email,created_at,next_at) values($1,$2,$3,$4,$5,$6,$7)',
      [id, 'camelrun-proto-local', 'agent-fixture', 'schedule-fixture', { to: 'reader@example.test', subject: 'Report' }, createdAt, Date.now() - 1]);
  };
  const row = async (id: string) => (await fixture.db.query('select * from schedule_deliveries where id=$1', [id])).rows[0];

  await t.test('a slow active send renews its lease, excludes duplicates, and stores the delivery receipt', async st => {
    const id = 'slow-send'; await insert(id);
    let resolveSend!: (value: { messageId: string }) => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const sent = new Promise<{ messageId: string }>(resolve => { resolveSend = resolve; });
    send = async mail => {
      assert.equal(mail.headers['X-CamelRun-Delivery'], id);
      assert.match(mail.html, /<strong>Synthetic report<\/strong>/);
      began(); return sent;
    };
    st.mock.timers.enable({ apis: ['setInterval'] });
    try {
      const delivery = deliverScheduleEmail(env, id);
      await started;
      assert.equal(await deliverScheduleEmail(env, id), false);
      // Expiry soon makes the renewal observable without a minute-long test.
      await fixture.db.query('update schedule_deliveries set lease_until=$2 where id=$1', [id, Date.now() + 10000]);
      st.mock.timers.tick(20000);
      for (let i = 0; i < 100 && Number((await row(id)).lease_until) < Date.now() + 30000; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(Number((await row(id)).lease_until) > Date.now() + 30000);
      resolveSend({ messageId: 'fake-delivery-receipt' });
      assert.equal(await delivery, true);
      assert.deepEqual({ state: (await row(id)).state, message: (await row(id)).message_id }, { state: 'sent', message: 'fake-delivery-receipt' });
      assert.equal((await row(id)).lease, null);
      assert.equal(await deliverScheduleEmail(env, id), true);
    } finally { resolveSend({ messageId: 'fake-delivery-receipt' }); st.mock.timers.reset(); }
  });

  await t.test('lost ownership before send never calls the mail binding', async () => {
    const id = 'lease-stolen'; await insert(id);
    read = async () => {
      await fixture.db.query('update schedule_deliveries set lease=$2 where id=$1', [id, 'another-consumer']);
      return Response.json({ state: 'completed', outcome: { result: { reply: 'report' } } });
    };
    send = async () => { throw Error('Mail must not be sent without owning the lease'); };
    assert.equal(await deliverScheduleEmail(env, id), false);
    assert.equal((await row(id)).lease, 'another-consumer');
  });

  await t.test('missing agents fail immediately; retryable failures stop after five attempts with backoff', async () => {
    for (const status of [404, 410]) {
      const id = `gone-${status}`; await insert(id);
      read = async () => new Response(null, { status });
      assert.equal(await deliverScheduleEmail(env, id), true);
      assert.equal((await row(id)).state, 'failed');
      assert.equal((await row(id)).error, 'Agent no longer exists');
    }
    const id = 'retry-limit'; await insert(id);
    read = async () => new Response(null, { status: 503 });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = Date.now();
      assert.equal(await deliverScheduleEmail(env, id), attempt === 5);
      const stored = await row(id);
      assert.equal(stored.attempts, attempt);
      assert.equal(stored.state, attempt === 5 ? 'failed' : 'waiting');
      assert.ok(Number(stored.next_at) >= before + 60000 * 2 ** (attempt - 1));
      await fixture.db.query('update schedule_deliveries set next_at=$2 where id=$1', [id, Date.now() - 1]);
    }
  });

  await t.test('an agent read is cancelled at the 15-second deadline', async () => {
    const id = 'read-timeout'; await insert(id);
    let inFlight:Request|undefined;
    read = async request => await new Promise((_, reject) => {
      // A real fetch retains its request until it settles. Keep the fake alive
      // too: Request's dependent AbortSignal uses a weak reference in Node.
      inFlight=request;
      assert.equal(request.signal.aborted, false);
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
    assert.equal(await deliverScheduleEmail(env, id), false);
    assert.equal(inFlight?.signal.aborted,true);
    assert.equal((await row(id)).attempts, 1);
    assert.equal((await row(id)).lease, null);
  });
});
