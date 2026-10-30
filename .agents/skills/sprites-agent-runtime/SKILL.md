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
dependencies or rebuilds v8-exec only when they changed, runs the command and releases the lease. When every sprite is busy it waits for one, printing who holds them; exit status 75 means none came free in
`SPRITE_WAIT_MINUTES` (default 30). Logs stay in `~/runs/` on the sprite.

The command runs as a service on the sprite and holds a Task, so a dropped connection or a sleeping laptop doesn't end it
or let the sprite pause. The script polls and streams its output; the job writes `~/runs/<id>.log` and `~/runs/<id>.exit` and releases the lease
itself. Exit status 69 means the script lost contact: the job carries on, so read those two files instead of rerunning.
Postgres runs as CI's does (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`, 1000 connections).

`SPRITE_ORG` changes the org, `SPRITE_POOL` the pool size, `SPRITE_LEASE_STALE` the seconds without a refresh after which a lease counts as dead and is taken over (default 300; a
live run refreshes every minute),
`SPRITE_RUN_HOURS` the job's time limit (default 2), `SPRITE_POLL_FAILURES` the failed polls before giving up (default
40, about 10 minutes), and `SPRITE_NAME` pins one sprite. Don't exec on a pool sprite outside a lease: another agent may be mid-run, and each run
replaces `~/rt`.

"Codemode sandbox process could not start (ENOENT)" means the v8-exec binary is missing. Tests that fail on the Mac but
pass here (the large-workflow sandbox tests) are Mac-specific. To start clean, restore a `ready` checkpoint if the sprite
has one: `sprite checkpoint list -o camelai -s <name>`.
