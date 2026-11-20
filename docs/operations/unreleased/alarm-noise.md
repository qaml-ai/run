# Sustained quota and sampled first-token alarms

After the operator applies the Terraform changes, the `quota_rejected` alarm requires at least 5 refusals in each of 3 consecutive
5-minute periods. Missing data does not breach. The `first_token_slow` alarm keeps
its p90 threshold of 60 seconds over 3 consecutive 5-minute periods, but each period
must have at least 20 `TimeToFirstTokenMs` samples to breach.
