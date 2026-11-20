### Atomic end-user credit transfers

End-user balances can be transferred within a tenant with `POST /v1/end-users/{id}/transfers`.
The body is `{to, amount, key, description?}`; amounts are charged micro-USD. This is an operator API. An application must authenticate the human and check membership itself before selecting either subject.

Both account rows are locked in a stable order. The source's unheld balance is debited and the destination credited in one transaction. Daily free allowances cannot be transferred. Expiring lots keep their expiry; money held by calls in flight stays at the source. One debit and one grant per transferred lot are returned as `{debit, credits, replayed}`. Retrying the same key, source, destination and amount returns those original entries without moving money again. Reusing the key for a different transfer returns 409.

There is no new migration or production write in this change. Test coverage includes opposing concurrent transfers, property tests for credit conservation, held credit, preserved expiry, API tenant isolation and existing lot behavior.
