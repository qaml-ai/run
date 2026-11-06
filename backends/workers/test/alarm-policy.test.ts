import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLATFORM_ALARMS, evaluateAlarm, type AlarmRule, type MetricBucket, type MetricPoint } from '../src/alarm-policy.ts';
import { recordEventMetrics, withMoneyMetrics } from '../src/money-metrics.ts';

const named = (id: string) => PLATFORM_ALARMS.find(rule => rule.id === id)!;
const window = (rule: AlarmRule, points: MetricPoint[][]): MetricBucket[] => points.map((points,index) => ({ start: index * rule.periodSeconds * 1000, periodSeconds: rule.periodSeconds, points }));
const evaluate = (rule: AlarmRule, points: MetricPoint[][]) => evaluateAlarm(rule, window(rule,points), points.length * rule.periodSeconds * 1000);

function block(text: string, kind: string, id: string) {
  const start = text.indexOf(`${kind} "${id}" {`);
  assert.ok(start >= 0, `Missing Terraform ${id}`);
  let depth = 0, quoted = false, escaped = false;
  for (let n = text.indexOf('{',start); n < text.length; n++) {
    const c = text[n];
    if (escaped) { escaped = false; continue; }
    if (quoted && c === '\\') { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) return text.slice(start,n+1);
    }
  }
  throw Error(`Unclosed Terraform ${id}`);
}

test('platform alarm periods, thresholds, names and comparisons match Terraform', async () => {
  for (const rule of PLATFORM_ALARMS) {
    const text = await readFile(new URL(`../../../infra/terraform/${rule.source}`,import.meta.url),'utf8');
    const resource = block(text,'resource "aws_cloudwatch_metric_alarm"',rule.id);
    const threshold = resource.match(/\bthreshold\s*=\s*([^\n]+)/)![1].trim();
    const numeric = threshold.startsWith('var.')
      ? Number(block(text,'variable',threshold.slice(4)).match(/\bdefault\s*=\s*([\d.]+)/)![1]) : Number(threshold);
    assert.equal(rule.threshold,numeric,rule.id);
    assert.equal(rule.periods,Number(resource.match(/\bevaluation_periods\s*=\s*(\d+)/)![1]),rule.id);
    const periods=[...resource.matchAll(/\bperiod\s*=\s*(\d+)/g)];
    assert.ok(periods.length > 0 && periods.every(match => Number(match[1]) === rule.periodSeconds),rule.id);
    assert.ok(resource.includes(`"${rule.comparison}"`),rule.id);
    assert.ok(resource.includes(`"${rule.missing}"`),rule.id);
    if (rule.signal.kind === 'stat') assert.ok(resource.includes(`"${rule.sourceMetric ?? rule.signal.select.metric}"`),rule.id);
    if (!rule.wired) assert.ok(rule.gap,`Unwired ${rule.id} needs an explanation`);
  }
});

test('turn failure alarm uses two complete windows, minimum traffic and a strict 40 percent threshold', () => {
  const rule = named('turn_failures');
  const points = (failed: number,total: number): MetricPoint[] => [
    { metric: 'Turns', value: failed, dimensions: { Outcome: 'failed' } },
    { metric: 'Turns', value: total-failed, dimensions: { Outcome: 'completed' } },
  ];
  assert.equal(evaluate(rule,[points(3,5),points(3,5)]).state,'firing');
  assert.equal(evaluate(rule,[points(2,5),points(3,5)]).state,'ok');
  assert.equal(evaluate(rule,[points(4,4),points(4,4)]).state,'ok');
  assert.equal(evaluateAlarm(rule,window(rule,[points(3,5)]),1800000).state,'insufficient');
  assert.equal(evaluate(rule,[[],[]]).state,'ok');
});

test('webhook lag uses the maximum and missing instrumentation cannot report healthy', () => {
  const rule = named('webhook_lag');
  const high = [{ metric: 'WebhookOldestPendingMs', value: 600001 },{ metric: 'WebhookOldestPendingMs', value: 1 }];
  assert.equal(evaluate(rule,[high,high]).state,'firing');
  assert.equal(evaluate(rule,[high,[]]).state,'ok');
  assert.equal(evaluateAlarm(named('runs_uncertain'),[],Date.now()).state,'insufficient');
  assert.equal(evaluate(rule,[[{metric:'WebhookOldestPendingMs',value:NaN}],high]).state,'insufficient');
});

test('unwired policy can be tested with synthetic signals without claiming production instrumentation', () => {
  const rates = { ...named('model_rate_limited'), wired: true };
  assert.equal(evaluate(rates,[[
    { metric:'ModelErrors',value:6,dimensions:{ErrorClass:'rate_limit'} },
    { metric:'ModelErrors',value:4,dimensions:{ErrorClass:'overloaded'} },
    { metric:'ModelErrors',value:100,dimensions:{ErrorClass:'auth'} },
  ]]).state,'firing');
  const first = { ...named('first_token_slow'), wired: true };
  const points = Array.from({length:10},(_,i)=>({metric:'TimeToFirstTokenMs',value:i>=8?60001:100}));
  assert.equal(evaluate(first,[points,points,points]).state,'firing');
});

test('source usage metrics feed global and per-tenant spend alarm selectors', () => {
  const points: MetricPoint[] = [];
  const env = { METRICS: { writeDataPoint(point: { indexes: string[]; doubles: number[]; blobs: string[] }) {
    points.push({ metric: point.indexes[0], value: point.doubles[0], dimensions: { Tenant: point.blobs[7] } });
  } } as unknown as AnalyticsEngineDataset };
  const log = console.log;
  console.log = () => {};
  try {
    withMoneyMetrics(env, () => recordEventMetrics([
      { id: 'one', type: 'usage.recorded', tenant: 'one', created: 1, data: { provider: 'fixture', model: 'test/model', cost: { usd: 60 } } },
      { id: 'two', type: 'usage.recorded', tenant: 'two', created: 2, data: { provider: 'fixture', model: 'test/model', cost: { usd: 50 } } },
    ]));
  } finally { console.log = log; }
  assert.equal(named('model_spend').wired, true);
  assert.equal(named('tenant_model_spend').wired, true);
  assert.equal(evaluate(named('model_spend'), [points]).state, 'firing');
  assert.equal(evaluate(named('tenant_model_spend'), [points]).state, 'firing');
  assert.equal(named('runs_uncertain').wired, false, 'a formatter alone does not prove restart instrumentation');
  assert.equal(named('webhook_failed').wired, false, 'scan failures also need an Analytics observation');
});
