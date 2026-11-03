### `limit_hit` says whose end-user credit refused

A `limit_hit` for `END_USER_CREDIT` now carries `endUser` (the tenant's subject), `bucket` and `reason` (balance,
daily_limit, bucket_limit), and is one line a minute per tenant, end user and bucket. Refusals that never reached an
HTTP answer are said too: a run refused as it starts (`route: "run_start"`, a queued run's included) and a model call
refused as it begins or streams (`model_call`, `model_stream`). Still no amounts and no words of the refusal.
