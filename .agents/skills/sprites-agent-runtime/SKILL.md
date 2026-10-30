---
name: sprites-agent-runtime
description: Run agent-runtime tests on the team's shared pool of prepared Fly.io Sprites instead of the laptop. For people with access to the `camelai` Fly.io org. Use when running test files or the full suite off the machine.
---

# agent-runtime sprites

For team members in the Fly.io org `camelai`; anyone else runs tests as [AGENTS.md](../../../AGENTS.md#build-and-test)
says. See the `sprites` skill for the CLI.

The pool is `rt-pool-1` to `rt-pool-3`, each with Postgres, `node_modules` and the v8-exec build. With your work
committed:

```sh
scripts/sprite-test                   # the full suite at HEAD; run it in the background
scripts/sprite-test origin/fix/x      # the full suite at a ref
scripts/sprite-test HEAD node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/<file>.test.ts
```

It leases a free sprite, ships the committed tree only (never `.env` or ignored files), resets Postgres, reinstalls
dependencies or rebuilds v8-exec only when they changed, runs the command and releases the lease. Exit status 75 means
every sprite is busy. Logs stay in `~/runs/` on the sprite.

`SPRITE_ORG` changes the org, `SPRITE_POOL` the pool size, `SPRITE_LEASE_HOURS` the takeover age (default 3), and
`SPRITE_NAME` pins one sprite. Don't exec on a pool sprite outside a lease: another agent may be mid-run, and each run
replaces `~/rt`.

"Codemode sandbox process could not start (ENOENT)" means the v8-exec binary is missing. Tests that fail on the Mac but
pass here (the large-workflow sandbox tests) are Mac-specific. To start clean, restore a `ready` checkpoint if the sprite
has one: `sprite checkpoint list -o camelai -s <name>`.
