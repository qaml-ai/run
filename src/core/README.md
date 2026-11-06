# Shared runtime logic

This directory holds one host-agnostic copy of camelRun policy. Both the Node runtime and the Workers app may import
it directly. Existing `src/` entry points can re-export a moved module while callers migrate.

Core modules may use ECMAScript built-ins and web-standard APIs: `fetch`, `crypto.subtle`, `crypto.getRandomValues`,
`TextEncoder`, `TextDecoder`, `URL`, streams and `structuredClone`. Imports may refer only to other modules in this
directory, the small host contracts in `host.ts`, and approved pure dependencies already used by the runtime. The
initial dependency allowlist is `zod`; extending it requires checking the package's runtime and types for host imports.

No `node:*`, `pg`, `Buffer`, `process` or imports from outside `src/core/` belong here, including type-only imports.
Configuration and effects come from explicit arguments. Hosts own database connections, timer lifecycle, networking
guards, filesystem and object storage adapters, cryptographic key handling and observability backends.

`host.ts` keeps only the seams demonstrated by the [extraction inventory](../../docs/core-extraction.md):

- `Sql` and `Rows` keep the current query shape. `Transaction` is the host-bound form of `transaction(db, work, options)`;
  connection ownership and retry behavior stay in the host, including `rerun: false` for nonrepeatable effects.
- `Clock` supplies epoch milliseconds and abortable sleep for expiry and retry policies. Scheduling timers stay outside
  core; no Node timer handles or `unref` cross the boundary.
- `Log` and `Metrics` accept prepared lines, as the current runtime and Workers metric sinks do. Event-specific policy
  and privacy filtering remain the caller's responsibility; these contracts do not prescribe a new telemetry system.
- `Config` is a read-only string map for existing environment parsers. It is passed explicitly.

`npm run check:core` checks imports and forbidden Node globals, type-checks this directory with `types: []` and the
WebWorker library, and bundles every runtime module with esbuild's neutral platform. It runs as part of
`npm run typecheck`, which CI already requires. Relative imports are resolved and checked against the real core path,
so a sibling import or symlink cannot pull host code across the boundary. Computed imports and triple-slash type
references are rejected. The neutral bundle includes dependencies rather than marking them external.

The first extraction is `calendar.ts`: its validation, DST handling and prompt formatting are unchanged. The old
`src/calendar.ts` exports the same API. See the inventory for the remaining extraction PRs and their host constraints.
