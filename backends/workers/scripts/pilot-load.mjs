#!/usr/bin/env node
/** Public-API load from a Sprite. Secrets arrive on stdin and remain in memory.
 * The laptop owns withPilotOperator(), its bounded tenant list and final cleanup.
 * Run with --stdin, supplying operatorBaseUrl/operatorToken/tenantIds/fakeBaseUrl.
 * Output contains only aggregate measurements, never request bodies or tokens.
 */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const PILOT = 'https://run-pilot.camelai.dev';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const latency = values => ({ samples: values.length, p50Ms: percentile(values, .50), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99) });
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);

class RequestError extends Error {
  constructor(status, code, reason, route, ray) { super(`HTTP ${status} ${code}`); this.status = status; this.code = code; this.reason = reason; this.route = route; this.ray = ray; }
}
function errorClass(error) {
  if (error instanceof RequestError) return `http_${error.status}:${error.code}${error.reason ? ':' + error.reason : ''}`;
  if (error?.name === 'TimeoutError') return 'client_timeout';
  if (error?.name === 'AbortError') return 'client_abort';
  return 'network_or_protocol';
}
function failureReason(value) {
  const message = typeof value === 'string' ? value : '';
  for (const [pattern, category] of [
    [/timeout exceeded when trying to connect/i, 'database_connect_timeout'],
    [/Query read timeout/i, 'database_query_timeout'],
    [/Connection terminated|connection error|ECONNRESET|ECONNREFUSED/i, 'database_connection_lost'],
    [/acquire.*connection|connection.*pool/i, 'database_pool_exhausted'],
    [/too many clients|too many connections/i, 'database_connection_limit'],
    [/deadlock/i, 'database_deadlock'],
    [/cpu.*limit|exceeded.*cpu/i, 'worker_cpu_limit'],
    [/memory.*limit|exceeded.*memory/i, 'worker_memory_limit'],
    [/too many.*subrequest/i, 'worker_subrequest_limit'],
    [/timed? ?out|timeout/i, 'timeout'],
    [/fetch failed|network|socket/i, 'network'],
  ]) if (pattern.test(message)) return category;
  return 'unclassified';
}
function publicCode(value) {
  // Never expose server messages, response bodies or provider credentials.
  return typeof value === 'string' && /^[A-Z_a-z0-9]{1,80}$/.test(value) ? value : 'unspecified';
}
async function mapLimit(items, count, action) {
  let next = 0;
  const values = new Array(items.length);
  const tasks = await Promise.allSettled(Array.from({ length: Math.min(items.length, count) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      values[index] = await action(items[index], index);
    }
  }));
  const failed = tasks.find(task => task.status === 'rejected');
  if (failed) throw failed.reason;
  return values;
}

export function loadTenantIds(runId, count = 20) {
  if (!/^[a-z0-9-]{1,20}$/.test(runId)) throw new Error('runId must be lowercase alphanumeric, at most 20 characters');
  return Array.from({ length: count }, (_, i) => `pilot-load-${runId}-${i}`);
}

export function mergeDbProfiles(values) {
  const result = { phases: {}, operations: {} };
  for (const value of values) {
    for (const [phase, count] of Object.entries(value?.operations ?? {})) result.operations[phase] = (result.operations[phase] ?? 0) + count;
    for (const [phase, metrics] of Object.entries(value?.phases ?? {})) {
      const target = result.phases[phase] ??= {};
      for (const [key, number] of Object.entries(metrics)) {
        if (key === 'statements') {
          const statements = target.statements ??= {};
          for (const [label, counters] of Object.entries(number)) {
            const current = statements[label] ??= { queries: 0, queryMs: 0, errors: 0 };
            for (const metric of Object.keys(current)) current[metric] += counters[metric];
          }
        } else if (Array.isArray(number)) (target[key] ??= []).push(...number);
        else if (key.endsWith('MaxMs')) target[key] = Math.max(target[key] ?? 0, number);
        else target[key] = (target[key] ?? 0) + number;
      }
    }
  }
  return result;
}

export async function runPilotLoad(options) {
  const { operatorBaseUrl, operatorToken, tenantIds, fakeBaseUrl } = options;
  const baseUrl = options.baseUrl ?? PILOT;
  if (baseUrl !== PILOT) throw new Error('This harness is restricted to run-pilot.camelai.dev');
  if (!/^https:\/\/camelrun-pilot-fakemodel\.[a-z0-9-]+\.workers\.dev(?:\/v1)?$/.test(fakeBaseUrl ?? '')) throw new Error('Expected the pilot fake-provider Worker');
  if (!/^https:\/\/camelrun-pilot-bootstrap-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(operatorBaseUrl ?? '')) throw new Error('Expected an ephemeral pilot operator Worker');
  if (typeof operatorToken !== 'string' || !Array.isArray(tenantIds) || !tenantIds.length || tenantIds.some(id => !/^pilot-load-[a-z0-9-]+$/.test(id))) throw new Error('Invalid bounded load credentials');
  const stages = options.stages ?? [1, 10, 50, 100, 250, 500, 1000, 2000];
  if (!stages.every(n => Number.isInteger(n) && n > 0 && n <= 2000) || stages.some((n, i) => i && n <= stages[i - 1])) throw new Error('Stages must increase, with at most 2000 agents');
  if (options.originSampleMs !== undefined && options.originSampleMs !== 0 && (!Number.isFinite(options.originSampleMs) || options.originSampleMs < 1000)) throw new Error('Origin sampling must be at least 1000ms, or zero to disable');
  const totalAgents = Math.max(...stages);
  const perTenant = Math.ceil(totalAgents / tenantIds.length);
  const report = { startedAt: new Date().toISOString(), target: baseUrl, fakeProvider: fakeBaseUrl, tenantCount: tenantIds.length, totalAgents, stages: [], setup: {}, cleanup: {}, errors: {}, errorSamples: [] };
  if (options.stopStageOnErrorRate) report.stopPolicy = { errorRate: .05, denominator: 'requested concurrency', action: 'abort known and late accepted turns; censor client observations; then durable cleanup', unknownAdmissions: 'Durable account cleanup remains authoritative for admissions whose HTTP response failed.' };
  if (options.originSampleMs) report.originSampling = { intervalMs: options.originSampleMs, queriesPerSample: 2, scope: 'before, during and after each stage; during samples run in the existing watcher, so intervals can exceed the target', additionalQueries: 'Two per before/during sample; after reuses the existing post-stage status query.' };
  const createdTenants = [];
  const agents = [];
  const recordError = error => {
    const name = errorClass(error); report.errors[name] = (report.errors[name] ?? 0) + 1;
    if (report.errorSamples.length < 20) report.errorSamples.push({ at: new Date().toISOString(), classification: name, ...(error?.route ? { route: error.route } : {}), ...(error?.ray ? { ray: error.ray } : {}) });
    return name;
  };
  let edgeProfiles;
  const request = async (base, token, path, init = {}) => {
    const response = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 120_000)])
        : AbortSignal.timeout(init.timeoutMs ?? 120_000),
    });
    if (edgeProfiles && base === baseUrl) {
      try { const profile = JSON.parse(response.headers.get('x-pilot-db-profile') ?? 'null'); if (profile) edgeProfiles.push(profile); } catch { /* profiling must not alter the workload */ }
    }
    const data = await response.json().catch(() => null);
    init.signal?.throwIfAborted();
    if (!response.ok) {
      const route = path.replace(/\/agents\/[^/]+/, '/agents/:id').replace(/\/end-users\/[^/]+/, '/end-users/:id').replace(/\/requests\/[^?]+/, '/requests/:id').split('?')[0];
      throw new RequestError(response.status, publicCode(data?.code), failureReason(data?.error), route, response.headers.get('cf-ray'));
    }
    return data;
  };
  const admin = (path, init) => request(operatorBaseUrl, operatorToken, path, init);
  const call = (tenant, path, init) => request(baseUrl, tenant.token, path, init);
  const inspect = () => admin('/pilot/inspect');
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    const setupAt = performance.now();
    for (const id of tenantIds) {
      const made = await admin('/v1/tenants', { body: { id, tokenName: 'ephemeral-load' } });
      const tenant = { id, token: made.token.token };
      createdTenants.push(tenant);
      await admin(`/v1/tenants/${id}/limits`, { method: 'PUT', body: { maxBusyAgents: perTenant + 5, agentCreatesPerMinute: 10000, runsPerMinute: 10000, maxRunResponses: 2, maxRunSeconds: 120 } });
      await admin('/v1/billing/adjustments', { body: { tenant: id, amount: 100_000_000, reason: 'Temporary pilot load-test credit; no payment', idempotencyKey: `load:${id}` } });
      await call(tenant, '/v1/providers/pilot-fake', { method: 'PUT', body: {
        type: 'openai-completions', baseUrl: fakeBaseUrl.replace(/\/v1$/, '') + '/v1', apiKey: 'pilot-fake-public',
        headers: { 'x-pilot-delay-ms': String(options.modelDelayMs ?? 5000) },
        models: [{ id: 'deterministic', contextWindow: 32768, maxOutputTokens: 1024, input: ['text', 'image'], pricing: { input: 1, output: 1 }, compat: { supportsUsageInStreaming: true } }],
      } });
      await call(tenant, '/v1/end-user-settings', { method: 'PUT', body: { enabled: true, markupBps: 0 } });
    }
    emit({ type: 'load_setup', tenants: createdTenants.length, agentsTarget: totalAgents });
    await mapLimit(Array.from({ length: totalAgents }, (_, i) => i), options.setupConcurrency ?? 25, async index => {
      if (interrupted) throw new Error('Interrupted');
      const tenant = createdTenants[index % createdTenants.length];
      const subject = `load-${index}`;
      await call(tenant, `/v1/end-users/${subject}/entries`, { body: { kind: 'grant', amount: 1_000_000, key: `load-grant:${subject}` } });
      const agent = await call(tenant, '/v1/agents', { body: { model: 'pilot-fake/deterministic', subject, systemPrompt: 'Reply briefly.', codeMode: false, fileTools: false, decide: false, ttlSeconds: 3600 } });
      agents[index] = { id: agent.id, tenant };
      if ((index + 1) % 250 === 0) emit({ type: 'load_setup_progress', created: index + 1 });
    });
    report.setup = { durationMs: performance.now() - setupAt, before: await inspect(), origin: await admin('/pilot/database-status') };

    for (const concurrency of stages) {
      if (interrupted) break;
      // Reset after provisioning and the prior stage. Diagnostics are outside
      // the timed workload and return aggregate counters only.
      const stageAgents = agents.slice(0, concurrency);
      const profiles = reset => mapLimit(stageAgents, 10, ({ id, tenant }) => admin('/pilot/database-profile', { body: { tenant: tenant.id, agent: id, reset } }));
      const beforeProfiles = await profiles(true);
      const originSampleMs = Number(options.originSampleMs ?? 0);
      const originSamples = originSampleMs > 0 ? [{ at: new Date().toISOString(), phase: 'before', ...await admin('/pilot/database-status') }] : undefined;
      edgeProfiles = [];
      const begunAt = performance.now();
      if (originSamples) stage.originSamples = originSamples;
      // Opt-in safety stop for later capacity ramps. Admissions remain observable:
      // aborting their HTTP response can hide a request accepted by the runtime.
      const stop = options.stopStageOnErrorRate ? new AbortController() : undefined;
      const acceptedAgents = new Map(), terminalAgents = new Set(), abortQueued = new Set();
      const abortLanes = Array.from({ length: 10 }, () => Promise.resolve());
      let nextAbortLane = 0, abortDeadline = Infinity;
      const abortAgent = entry => {
        if (abortQueued.has(entry.id)) return;
        abortQueued.add(entry.id);
        const lane = nextAbortLane++ % abortLanes.length;
        abortLanes[lane] = abortLanes[lane].then(async () => {
          if (Date.now() >= abortDeadline) { stage.stop.abortUnattempted++; return; }
          stage.stop.abortAttempted++;
          try {
            await call(entry.tenant, `/v1/agents/${entry.id}/abort`, { body: {}, timeoutMs: Math.min(15_000, abortDeadline - Date.now()) });
            stage.stop.abortSucceeded++;
          } catch { stage.stop.abortFailed++; }
        });
      };
      const stopStage = () => {
        if (!stop || stop.signal.aborted) return;
        stage.censored = true;
        stage.cancelled = 0;
        stage.stop = { reason: 'error_rate_exceeded_5_percent', at: new Date().toISOString(), elapsedMs: performance.now() - begunAt,
          completed: stage.completed, failed: stage.failed, accepted: stage.accepted, inFlight,
          errorRate: stage.failed / concurrency, abortAttempted: 0, abortSucceeded: 0, abortFailed: 0, abortUnattempted: 0 };
        abortDeadline = Date.now() + 60_000;
        stop.abort(new DOMException('Pilot stage stopped at its error threshold', 'AbortError'));
        for (const [id, entry] of acceptedAgents) if (!terminalAgents.has(id)) abortAgent(entry);
      };
      let inFlight = 0, watching = true;
      let nextOriginSampleAt = Date.now() + originSampleMs;
      const acceptTimes = [], turnTimes = [];
      const watcher = (async () => {
        while (watching) {
          try {
            const counts = await inspect();
            stage.samples.push({ at: new Date().toISOString(), ...counts });
            if (originSamples && Date.now() >= nextOriginSampleAt) {
              originSamples.push({ at: new Date().toISOString(), phase: 'during', ...await admin('/pilot/database-status') });
              nextOriginSampleAt = Date.now() + originSampleMs;
            }
          } catch (error) { stage.instrumentationError = errorClass(error); }
          if (watching) await pause(2000);
        }
      })();
      emit({ type: 'load_stage_start', concurrency, startedAt: stage.startedAt });
      // All agents in this stage start one independent, metered turn together.
      // No retry hides an admission, Hyperdrive, origin or Durable Object error.
      await Promise.all(agents.slice(0, concurrency).map(async ({ id, tenant }, index) => {
        const at = performance.now();
        inFlight++; stage.maxClientInFlight = Math.max(stage.maxClientInFlight, inFlight);
        try {
          const accepted = await call(tenant, `/v1/agents/${id}/prompt`, { body: { text: `pilot-load:${concurrency}:${index}`, requestId: `load-${concurrency}-${index}` } });
          stage.accepted++; acceptTimes.push(performance.now() - at);
          acceptedAgents.set(id, { id, tenant });
          if (stop?.signal.aborted) { abortAgent({ id, tenant }); throw stop.signal.reason; }
          const deadline = Date.now() + 150_000;
          let done;
          while (Date.now() < deadline) {
            stop?.signal.throwIfAborted();
            done = await call(tenant, `/v1/agents/${id}/requests/${encodeURIComponent(accepted.id)}?wait=25`, { timeoutMs: 40_000, ...(stop ? { signal: stop.signal } : {}) });
            if (done.state === 'completed') break;
            if (['failed', 'cancelled', 'canceled'].includes(done.state)) { terminalAgents.add(id); throw new RequestError(200, `request_${publicCode(done.state)}`); }
          }
          if (done?.state !== 'completed') throw new RequestError(200, 'turn_timeout');
          terminalAgents.add(id);
          if (done.outcome?.result?.error || done.outcome?.result?.stopped || typeof done.outcome?.result?.reply !== 'string') throw new RequestError(200, `turn_${publicCode(done.outcome?.result?.code ?? done.outcome?.result?.stopped ?? 'failed')}`, failureReason(done.outcome?.result?.error));
          stage.completed++; turnTimes.push(performance.now() - at);
        } catch (error) {
          if (stop?.signal.aborted && error?.name === 'AbortError') { stage.cancelled++; return; }
          stage.failed++;
          const name = recordError(error);
          stage.errors[name] = (stage.errors[name] ?? 0) + 1;
          if (stage.failed / concurrency > .05) { interrupted = true; stopStage(); }
        } finally { inFlight--; }
      }));
      if (stage.censored) await Promise.all(abortLanes);
      watching = false; await watcher;
      stage.finishedAt = new Date().toISOString();
      stage.durationMs = performance.now() - begunAt;
      stage.turnsPerSecond = stage.completed / (stage.durationMs / 1000);
      stage.errorRate = stage.failed / concurrency;
      stage.acceptLatency = latency(acceptTimes);
      stage.turnLatency = latency(turnTimes);
      if (stage.censored) {
        stage.observedTurnsPerSecond = stage.turnsPerSecond;
        stage.observedCompletedTurnLatency = stage.turnLatency;
        stage.turnsPerSecond = null;
        stage.turnLatency = null;
      }
      stage.after = await inspect();
      if (stage.censored) {
        const drainUntil = Date.now() + 60_000;
        const unsettled = () => ['pending_attempts', 'holds', 'held_micros'].some(key => stage.after[key] > 0);
        while (Date.now() < drainUntil && unsettled()) {
          await pause(2000);
          stage.after = await inspect();
        }
        stage.stop.financialDrainAt = new Date().toISOString();
        stage.stop.financialDrainComplete = !unsettled();
      }
      stage.origin = await admin('/pilot/database-status');
      if (originSamples) originSamples.push({ at: new Date().toISOString(), phase: 'after', ...stage.origin });
      if (stage.censored) stage.databaseProfile = { skipped: true, reason: 'censored_stage_prioritizes_abort_and_cleanup', agent: { phases: {}, operations: {} }, edge: mergeDbProfiles(edgeProfiles), objectRestarts: null };
      else {
        const afterProfiles = await profiles(false);
        stage.databaseProfile = { agent: mergeDbProfiles(afterProfiles), edge: mergeDbProfiles(edgeProfiles), objectRestarts: afterProfiles.filter((p, i) => p.epoch !== beforeProfiles[i].epoch).length };
      }
      edgeProfiles = undefined;
      report.stages.push(stage);
      emit({ type: 'load_stage_result', ...stage, samples: stage.samples.length });
      // Give already accepted work its result, then stop the next ramp immediately.
      if (stage.errorRate > .05) { report.stoppedReason = 'error_rate_exceeded_5_percent'; break; }
      if (interrupted) { report.stoppedReason = 'interrupted_or_early_error_threshold'; break; }
    }
    report.beforeCleanup = await inspect();
  } catch (error) {
    recordError(error);
    report.stoppedReason = 'setup_or_instrumentation_error';
  } finally {
    report.cleanup.startedAt = new Date().toISOString();
    const cleanupResults = await mapLimit(createdTenants, 4, async tenant => {
      try {
        const until = Date.now() + 900_000;
        let state = await admin('/pilot/cleanup', { body: { tenant: tenant.id }, timeoutMs: 40_000 });
        while (Date.now() < until) {
          if (state.state === 'deleted') {
            let revoked = false;
            try { await call(tenant, '/v1/me'); } catch (error) { revoked = error instanceof RequestError && error.status === 401; }
            return { deleted: true, revoked };
          }
          await pause(2000);
          state = await admin(`/v1/tenants/${tenant.id}/deletion`, { timeoutMs: 40_000 });
        }
        return { deleted: false, reason: 'deletion_timeout' };
      } catch (error) { return { deleted: false, reason: errorClass(error) }; }
    });
    report.cleanup.deletedTenants = cleanupResults.filter(x => x.deleted).length;
    report.cleanup.revokedCredentials = cleanupResults.filter(x => x.revoked).length;
    report.cleanup.failures = cleanupResults.filter(x => !x.deleted);
    try { report.cleanup.after = await inspect(); } catch (error) { report.cleanup.inspectError = errorClass(error); }
    report.finishedAt = new Date().toISOString();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  emit({ type: 'load_report', report });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--stdin') { console.error('Use --stdin; input credentials never belong in command arguments.'); process.exitCode = 2; }
  else {
    try {
      let input = '';
      for await (const chunk of process.stdin) { input += chunk; if (input.length > 32768) throw new Error('Input too large'); }
      const report = await runPilotLoad(JSON.parse(input));
      process.exitCode = report.stoppedReason || report.cleanup.failures.length ? 1 : 0;
    } catch { console.error('Pilot load failed before a report could be produced.'); process.exitCode = 1; }
  }
}
