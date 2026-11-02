### File tools use Pi for text reads, writes and edits

Models and API clients now edit with `{ path, edits: [{ oldText, newText }] }`.
Each span must be unique in the original file, and edits must not overlap.
The old `old`, `new` and `replaceAll` arguments are no longer supported.
Edits include a diff and patch in their results, bounded for large changes.
Text reads now take a 1-based line `offset` and a line `limit`, with continuation
hints when more remains. In `js_exec`, text reads return an object with `content`
and any truncation details. Text writes create parent directories implicitly. Stale reads still cannot overwrite another writer's work.
Image and PDF references, PDF character windows and base64 byte reads and writes
keep their existing behavior. See `docs/guides/files.md`.
