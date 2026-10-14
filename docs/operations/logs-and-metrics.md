# Logs and metrics

Where the hosted runtime's logs and metrics are, and queries that answer the usual questions. Everything is in
us-west-2.

- **Logs:** the log group `/ecs/camelai-agent-runtime`, kept 30 days. The runtime writes one JSON object per line
  with a `type` (`turn_metrics`, `model_error`, `run_failed`, `model_cost`, `quota_rejected`, `webhook_failed`, ...)
  and ids, sizes and error classes, never message text.
- **Metrics:** namespace `AgentRuntime`, every metric with the dimension `ServiceName=camelai-agent-runtime`. The
  runtime writes them as CloudWatch embedded metric format lines in the same log group (`src/metrics.ts`), so a
  metric and the log line it came from always agree. Log metric filters add `AgentRuntime/Logs`,
  `AgentRuntime/Mail` and `AgentRuntime/Billing`.
- **Dashboard:** `camelai-agent-runtime-launch` (`infra/terraform/observability.tf`).

## Logs Insights

The quickest way to ask the logs a question. In the console (CloudWatch, Logs Insights, the log group above) or:

```sh
id=$(aws logs start-query --region us-west-2 --log-group-name /ecs/camelai-agent-runtime \
  --start-time $(( $(date +%s) - 3600 )) --end-time $(date +%s) \
  --query-string 'filter type = "run_failed" | stats count() as n by Tenant, ErrorClass | sort n desc' \
  --query queryId --output text)
sleep 5; aws logs get-query-results --region us-west-2 --query-id "$id"
```

Useful filters:

| Question | Query |
|---|---|
| Which tenants' runs fail, and how | `filter type = "run_failed" \| stats count() by Tenant, ErrorClass` |
| Which models fail | `filter type = "model_error" \| stats count() by Provider, Model, ErrorClass` |
| Who spends | `filter type = "model_cost" \| stats sum(ModelCostUsd) as usd by Tenant \| sort usd desc` |
| Turns by outcome | `filter type = "turn_metrics" \| stats count() by Outcome` |
| Refused at a cap | `filter type = "quota_rejected"` |
| Deploys: tasks retiring | `filter type in ["retiring", "retired"]` |
| Tool server credentials | `filter type = "tool_credential_exchange" and Outcome != "fetched"` |

## Counting log events from the CLI

The local AWS CLI is v1, which has no `aws logs tail`. `filter-log-events` pages through results itself, and applies
`--query` to each page, so `--query 'length(events)'` prints one number per page (`218` then `0` for a single
hour's `turn_metrics`), not a total. Count the timestamps instead:

```sh
aws logs filter-log-events --region us-west-2 --log-group-name /ecs/camelai-agent-runtime \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern '{ $.type = "turn_metrics" }' \
  --query 'events[].timestamp' --output text | wc -w
```

The same with `--query 'events[].message'` prints the lines themselves (here, the last 15 minutes):

```sh
aws logs filter-log-events --region us-west-2 --log-group-name /ecs/camelai-agent-runtime \
  --start-time $(( ($(date +%s) - 900) * 1000 )) --query 'events[].message' --output text
```

Logs Insights `stats count()` is the better tool for anything larger than a few thousand lines.

## Which models are slow or failing

`TimeToFirstTokenMs` (from a turn's start to its first streamed token), `Turns`, `ModelRetries` and `ModelErrors`
are published by `Provider` and `Model` as well as for the whole service. One `get-metric-data` call with `SEARCH`
returns them for every model at once, here as one value per model over the last three hours:

```sh
cat > models.json <<'EOF'
[
  {"Id": "ttft_p90", "Expression": "SEARCH('{AgentRuntime,ServiceName,Provider,Model} MetricName=\"TimeToFirstTokenMs\" ServiceName=\"camelai-agent-runtime\"', 'p90', 10800)"},
  {"Id": "turns", "Expression": "SEARCH('{AgentRuntime,ServiceName,Provider,Model} MetricName=\"Turns\" ServiceName=\"camelai-agent-runtime\"', 'Sum', 10800)"},
  {"Id": "retries", "Expression": "SEARCH('{AgentRuntime,ServiceName,Provider,Model} MetricName=\"ModelRetries\" ServiceName=\"camelai-agent-runtime\"', 'Sum', 10800)"},
  {"Id": "errors", "Expression": "SEARCH('{AgentRuntime,ServiceName,Provider,Model} MetricName=\"ModelErrors\" ServiceName=\"camelai-agent-runtime\"', 'Sum', 10800)"}
]
EOF
now=$(( $(date +%s) / 300 * 300 ))
aws cloudwatch get-metric-data --region us-west-2 --start-time $(( now - 10800 )) --end-time $now \
  --metric-data-queries file://models.json \
  --query 'MetricDataResults[?Values[0]].[Id,Label,Values[0]]' --output text | sort -k1,1 -k5,5nr
```

Each line is the query, the model (`<model id> <provider>`, e.g. `claude-sonnet-5-5 anthropic`), the metric and the
value; `TimeToFirstTokenMs` is in milliseconds. Read a model's p90 with its turn count: a slow model with a handful
of turns moves the fleet's p90 less than a slightly slow model with most of the traffic. Retries and errors for the
same model say whether it is slow or failing and being retried. For a time series instead of one value, use a
shorter period (300) and leave out the `?Values[0]` filter. Other statistics work in place of `p90` (`p50`,
`Average`, `Maximum`).

The same pattern with `{AgentRuntime,ServiceName,ErrorClass}` breaks `Turns` or `ModelErrors` down by error class,
and `{AgentRuntime,ServiceName,Tenant}` breaks `ModelCostUsd` or `RunsStarted` down by tenant; the dashboard's
`SEARCH` expressions (`observability.tf`) are working examples.
