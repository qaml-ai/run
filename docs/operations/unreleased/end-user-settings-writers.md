### End-user settings: concurrent writers keep each other's changes

- `PUT` and `PATCH /v1/end-user-settings` now write only the fields they send, in one statement, and a `PATCH` merges
  its `allowances` and `bucketLimits` keys into the map as it stands when the write lands. Before, each write read the
  row and wrote every field back, so a write that overlapped another (a node's `configure` at start while an operator
  changed `markupBps`, two `PATCH`es adding different keys) could silently undo it. See
  [End-user credits](../guides/end-user-credits.md#turn-it-on).
