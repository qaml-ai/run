# Local Hyperdrive transaction spike

See `../../docs/hybrid-hyperdrive.md` for scope, measurements and limitations.

From this directory, with Docker running and `npm ci` already run in the
backend root:

```sh
npm ci
npm test
npm run typecheck
```

`npm test` creates and deletes its own loopback-only PostgreSQL container,
applies all repository migrations, runs the local Worker/DO and writes the
sanitized measurement report. It accepts no external database URL. The
all-zero Hyperdrive ID is a local placeholder, not a deployed resource.
Do not deploy this unauthenticated test Worker.
