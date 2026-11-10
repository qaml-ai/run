### Usage by bucket

Account, agent, and workspace usage reports accept `bucket` in `groupBy`.
Known buckets are captured with each call and kept through later cost corrections.
Usage recorded without a bucket, including earlier history and older servers'
writes during deployment, appears in the null bucket. Reports include that usage
in their totals. Costs remain in USD.
