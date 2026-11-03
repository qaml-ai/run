### End-user usage over time

End-user usage charts can read `GET /v1/end-users/{id}/usage` (`endUsers.usage` in TypeScript, `end_users.usage` in Python). It sums usage by posting hour or UTC day, bucket, call and agent, with optional time and bucket filters. Amounts include allowance, paid spend and write-offs. See `docs/guides/end-user-credits.md`.
