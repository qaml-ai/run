### Vendored Pi carries our own patches

`vendor/pi/patches/*.patch` are changes of ours to Pi, applied on top of the vendored commit by `scripts/vendor-pi.sh`
before it builds (`docs/operations/pi-vendoring.md`). The packages are now versioned
`1.4.0-main.02a2b2532d8f-camel.4` (upstream version, `main.<commit>`, `camel.<number of patches>`), so a build of ours never
passes for an npm release. The four patches add Pi features the host does not use yet (no behaviour change):

- `GenerationHooks.beforeRetry`: the host decides whether and when a failed model request is retried.
- `settings.retry.keepRetried: false`: failed attempts that are asked again stay out of the transcript.
- `afterTools` returning `{ end: true }` ends the run after the tool round.
- `readStoredContext(storage, conversationId, context, { at })`: Pi's context derivation from Storage alone.

No stored document or task version changes: this deploy can be rolled back.
