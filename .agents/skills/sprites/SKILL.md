---
name: sprites
description: Run work on Fly.io Sprites (sprites.dev), persistent Linux VMs driven by the `sprite` CLI. Use for running tests or builds off the laptop, a clean Linux box, Linux-only tooling, long jobs, or anything that should not load or touch the local machine. Also for listing, creating, checkpointing or destroying sprites, and for moving files to and from one.
---

# Sprites

A sprite is a persistent Linux VM that pauses when idle and wakes on use; its filesystem survives pauses. Use the
`sprite` CLI (`~/.local/bin`), not the Sprites MCP server: only the CLI moves local files directly. Prefer a sprite to
loading the laptop for tests and builds.

If the repo has a sprite skill or `scripts/sprite-test`, use that and its pool first. Other agents share these
sprites, so don't run on a pool sprite outside its lease.

The team's shared pools are in the Fly.io org `camelai` (10 running at once). Pass `-o <org>` when you belong to more
than one. Install the CLI with `curl -fsSL https://sprites.dev/install.sh | sh`, then run `sprite login`.

## Commands

```sh
sprite list                                        # --json for status and limits
sprite create --skip-console <name>                # without the flag it opens a console
sprite exec -s <name> --no-stdin -- sh -c '<cmd>'  # exit status is the command's
printf data | sprite exec -s <name> --stdin -- sh -c 'cat > f'
sprite exec -s <name> --dir /home/sprite/x --env K=v,K2=v2 --no-stdin -- <cmd> [args]
sprite checkpoint create -s <name> --comment "deps installed"
sprite checkpoint list -s <name>; sprite restore -s <name> <id>   # restore is in place
sprite destroy -force <name>                       # irreversible: only when asked, or for a sprite you made
sprite info <name>; sprite url -s <name>; sprite proxy -s <name> 8080
sprite sessions list -s <name>                     # running execs; sprite attach / sessions kill <id>
sprite api /v1/sprites -- -s                       # raw API: curl options go after `--`
```

Always pass `--no-stdin` (or `--stdin` when piping) to `exec`: without either, an exec that loses its connection can't
reconnect. `sprite upgrade` needs a TTY; reinstall instead. `sprite api`
prints `Calling API:` and `URL:` lines before the body, so strip them before parsing. API spec:
https://api.sprites.dev/openapi.json.

## Moving files

```sh
sprite file push -s <name> ./a.conf /etc/a.conf    # -p makes missing parents, -r copies a directory
sprite file pull -s <name> -r /srv/dist/ ./dist/
```

Use these for single files and outputs. For a repo, ship the committed tree instead, so `.env`, keys and ignored files
stay home. Never copy secrets to a sprite unless the user asks.

```sh
git archive --format=tar.gz HEAD | sprite exec -s <name> --stdin -- sh -c 'mkdir -p ~/src && cd ~/src && tar xzf -'
```

## What a sprite has

Ubuntu, user `sprite` with passwordless sudo, home `/home/sprite`. Under `/.sprite/bin`: node (24), npm, git, cargo and
rustup. No Docker, no Postgres. Services don't restart after a pause: run `sudo service postgresql start` again.

## Long jobs

`nohup … &` inside an exec keeps running after the exec returns, and a running job keeps the sprite awake. Log to a
file and poll:

```sh
sprite exec -s <name> --no-stdin -- sh -c 'nohup sh -c "make > ~/job.log 2>&1; echo EXIT \$? >> ~/job.log" >/dev/null 2>&1 & echo started'
sprite exec -s <name> --no-stdin -- sh -c 'tail -5 ~/job.log'
```

Checkpoint a sprite once it is set up, so a broken state can be undone.

## Forking

Sprites can't be forked or cloned, and a sprite can't be created from another's checkpoint (checked 2026-10-30). Make
setup a script. Check CLI help and the API spec before saying this is still true.
