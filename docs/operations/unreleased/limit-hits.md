### Limit hits are logged with the tenant

A `limit_hit` line (`tenant`, `limit`, `status`, `route`) when a limit refuses someone with a 402, 413, 429 or 507, in the
API, the volumes and `TOOL_FILE_LIMITS` (`tool_file_*`); never what was refused. One line per tenant, limit and minute on
each node, then `limit_hit_repeats` with how many more came. `turn_metrics` for `spend_limit` and `turn_limit` turns adds
`tenant`, and `limit` and `limitReason` where known. Per-address 429s carry the tenant when the request's credential
checks out, and `tenant: null` otherwise.

```text
filter type = "limit_hit" | stats count(*) by tenant, limit, status, route
```
