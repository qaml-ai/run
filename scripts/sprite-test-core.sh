# sprite-test-core.sh: the shared machinery behind scripts/sprite-test in qaml-ai/run and qaml-ai/camel-bots, each of which
# keeps a copy at scripts/sprite-test-core.sh (keep the two the same). A repo's script sets its configuration, then
# sources its own copy with its arguments:
#
#   sprite_requires="leases dirty-denylist docker postgres-docker node22"   # core features it uses (checked, below)
#   sprite_prefix=rt-pool-  sprite_pool=42  sprite_shards=8                # pool rt-pool-1..42; the full suite's shards
#   sprite_dir=rt                                                          # the checkout on a sprite: ~/rt
#   sprite_keep="node_modules/ /sandbox/v8-exec/target/"                   # kept across syncs (rsync --exclude syntax)
#   sprite_build_path=sandbox/v8-exec                                      # its tree hash is in the fingerprint: $build
#   sprite_apt="gcc libc6-dev"                                             # packages, installed once per sprite
#   sprite_pg_env="TEST_DATABASE_URL"                                      # exported, naming the run's Postgres
#   sprite_sha_env=CONTRACT_REVISION                                       # optional: exported as the commit's sha
#   sprite_prepare='...'                     # shell run in the checkout after npm ci, before the command; may use $build
#   sprite_default_job() { echo "npm run test:shard -- $1/$2"; }           # the command for shard $1 of $2
#   sprite_option() { ...; }                 # optional: consume a repo-only --option ($1); return 1 if not one
#   sprite_tree() { ...; }                   # optional: add to the tree in $1 before it is sent
#   source "$core" "$@"
#
# What every repo gets: a lease per sprite from a shared coordinator, the committed tree (or --dirty's working tree) sent
# by rsync, Node 22 first on PATH, Docker with Buildx (dockerd as a sprite-env service), a fresh Postgres 16 container
# per run with CI's flags (tmpfs, durability off, 1000 connections, as .github/actions/test-postgres), npm ci when
# package-lock.json or Node changed, then the command, detached, followed with long polls. Options and settings: the
# usage text below (scripts/sprite-test --help). Exit status: the command's (the worst shard's); 75 when not enough sprites
# were free for SPRITE_WAIT_MINUTES; 69 when contact was lost (the job carries on); 137 when the job was killed or died;
# 2 for a usage or configuration error.
#
# Leases. A coordinator sprite (SPRITE_COORDINATOR, default rt-coordinator, shared by every pool: leases are kept by
# sprite name) keeps one lease file under flock, and every lease operation is one exec there. Acquire takes all the
# sprites a run needs at once (free: no lease, one not renewed for SPRITE_LEASE_STALE seconds, default 300, or one older
# than SPRITE_RUN_HOURS plus 10 minutes), preferring sprites already synced at the commit, then ones with the same
# package-lock.json and build path. A run renews its leases every minute and releases them at the end, recording the
# commit each sprite now has. On each sprite a lock directory ~/lease (mkdir is atomic) backs the lease: a run claims it
# before using the sprite, and its job refreshes it every minute. A claim that finds it fresh tells the coordinator the
# sprite is held and takes another; a stale lock, or one under a coordinator lease that is over-age yet still renewed,
# stops whatever was left there and takes it. A job starts only while ~/lease is the run's own. If the coordinator can't
# be reached within about 20 s, the run says so and probes the sprites one by one, on ~/lease alone.
#
# Sync. git archive of the commit into a temporary directory (never the working directory), sent with rsync over ssh
# through `sprite proxy --ssh` (no sshd or keys on the sprite); the kept paths stay, --delete removes the rest. rsync runs
# every time, even when ~/.synced names the commit: it checks the tree. If rsync fails, the tree goes as a tar stream.
#
# The job starts detached (nohup setsid) from one short exec. Every minute it refreshes ~/lease and renews a Sprites task
# (a sprite pauses a few seconds after its last exec ends unless a task holds it awake). Sprites restarts a sprite now
# and then, dropping its processes and last writes: a job gone without an exit status runs again on the same sprite.
# Ctrl-C stops the jobs; if the script dies instead, the jobs finish anyway and free their sprites.

SPRITE_CORE_VERSION=1
# Each feature a repo's configuration may name in sprite_requires. Add one whenever the core gains something a repo
# relies on, so a repo whose configuration needs it fails at once on an older core instead of misbehaving.
SPRITE_CORE_FEATURES="leases warm status stats grow reap fetch dirty dirty-denylist shards artifacts targeted hooks docker postgres-docker node22 check-core"

sprite_core=${BASH_SOURCE[0]}
sprite_core_missing=
for f in ${sprite_requires:-}; do [[ " $SPRITE_CORE_FEATURES " == *" $f "* ]] || sprite_core_missing+=" $f"; done
if [[ ${1:-} == --check-core ]]; then
  echo "sprite-test core $SPRITE_CORE_VERSION at $sprite_core"
  echo "features: $SPRITE_CORE_FEATURES"
  [[ -z $sprite_core_missing ]] || { echo "missing, required by this repo:$sprite_core_missing" >&2; exit 1; }
  echo "this repo requires: ${sprite_requires:-(nothing)}: all present"; exit 0
fi
if [[ -n $sprite_core_missing ]]; then
  echo "== this sprite-test core ($sprite_core, version $SPRITE_CORE_VERSION) lacks what this repo's scripts/sprite-test needs:$sprite_core_missing." >&2
  echo "   Update scripts/sprite-test-core.sh from the other repo's copy, or add the feature to both." >&2
  exit 2
fi
for v in sprite_prefix sprite_pool sprite_shards sprite_dir sprite_pg_env; do
  [[ -n ${!v:-} ]] || { echo "== scripts/sprite-test must set $v before sourcing the core" >&2; exit 2; }
done
declare -F sprite_default_job >/dev/null || { echo "== scripts/sprite-test must define sprite_default_job" >&2; exit 2; }

set -euo pipefail
org=${SPRITE_ORG:-camelai}; pool=${SPRITE_POOL:-$sprite_pool}; stale_s=${SPRITE_LEASE_STALE:-300}; coordinator=${SPRITE_COORDINATOR:-rt-coordinator}
max_age=$(awk -v hours="${SPRITE_RUN_HOURS:-2}" 'BEGIN { print int(hours * 3600 + 600) }')
wait_s=$(( ${SPRITE_WAIT_MINUTES:-30} * 60 )); lost_s=$(( ${SPRITE_LOST_MINUTES:-10} * 60 ))
pg_port=55432
cd "$(git rev-parse --show-toplevel)"

usage() {
  cat <<USAGE
scripts/sprite-test [options] [ref] [command...]: run tests at <ref> (default HEAD) on the ${sprite_prefix}N sprites.
  (no command)              the full pass: $sprite_shards shards on $sprite_shards sprites at once (SPRITE_SHARDS)
  command...                any command, in the checkout; {shard} and {shards} are replaced per --shards slot
  --targeted FILE...        node --test on these files, at HEAD
  --dirty                   the working tree (staged, unstaged, untracked; .gitignore applies) as a temporary commit,
                            without secrets: .env*, .dev.vars*, *.pem, *.key, *.p12, *.pfx, SSH keys (id_*), *.tfvars,
                            credentials files, .netrc, .npmrc: those changes never leave the laptop (it lists them)
  --shards=N                one command per lease, on N sprites
  --artifacts=DIR --output=LOCAL   collect DIR (relative, in the checkout) from each sprite into LOCAL/shard-N
  --warm [ref]              prepare every free sprite not yet at <ref>
  --status | --stats        the leases and each sprite's commit | the pool at a glance
  --grow N                  create and warm N more pool sprites
  --reap [days]             sprites nothing has used in that many days (default 14); deletes nothing
  --fetch SPRITE PATH [TO]  bring a result back with rsync (PATH relative to the sprite's home: ~/runs/<id>.log)
  --check-core              the core's version and features, against what this repo requires
Settings: SPRITE_SHARDS, SPRITE_NAME (pin sprites), SPRITE_POOL (default $sprite_pool), SPRITE_ORG, SPRITE_COORDINATOR,
SPRITE_LEASE_STALE, SPRITE_WAIT_MINUTES (30), SPRITE_RUN_HOURS (2), SPRITE_LOST_MINUTES (10), SPRITE_RETRIES (1).
Core: $sprite_core (version $SPRITE_CORE_VERSION).
USAGE
}

# The coordinator's side: coord <op> <args...>. leases has a line per lease: sprite id owner ref fingerprint started
# heartbeat; synced has a line per sprite: sprite fingerprint (sha:package-lock:build) time, as its last run left it.
read -r -d '' COORD <<'EOF' || true
set -eu
d=$HOME/sprite-test; mkdir -p "$d"; touch "$d/leases" "$d/synced"
exec 9> "$d/lock"; flock -w 15 9
now=$(date +%s); op=$1; shift
field() { awk -v s="$1" -v f="$2" '$1 == s { print $f }' "$d/$3"; }
put() { { awk -v s="$1" '$1 != s' "$d/leases"; [ -z "$2" ] || echo "$2"; } > "$d/leases.new"; mv "$d/leases.new" "$d/leases"; }
case $op in
acquire) # <count|any:count> <stale> <max-age> <fingerprint> <owner> <ref> <sprite...>: count free sprites, or none and exit 75
  # (any: as many as are free and not already synced at the fingerprint, for --warm)
  want=$1 stale=$2 max_age=$3 fp=$4 owner=$5 ref=$6; shift 6; free=
  for s in "$@"; do
    hb=$(field "$s" 7 leases); started=$(field "$s" 6 leases)
    if [ -n "$hb" ] && [ $(( now - hb )) -le "$stale" ] && [ $(( now - started )) -le "$max_age" ]; then echo "busy $s $(field "$s" 3 leases) $(( now - hb ))s"; continue; fi
    syn=$(field "$s" 2 synced); score=0
    if [ "$want" != "${want#any:}" ] && [ "$syn" = "$fp" ]; then echo "current $s"; continue; fi
    if [ "$syn" = "$fp" ]; then score=3; elif [ "${syn#*:}" = "${fp#*:}" ]; then score=2; elif [ "$(echo "$syn" | cut -d: -f2)" = "$(echo "$fp" | cut -d: -f2)" ]; then score=1; fi
    free="$free$score $s
"
  done
  n=${want#any:}; picked=$(printf %s "$free" | sort -s -k1,1nr | head -n "$n" | awk '{ print $2 }')
  [ "$want" != "$n" ] || [ "$(printf %s "$picked" | grep -c .)" -ge "$n" ] || exit 75
  for s in $picked; do
    age=; holder=; started=$(field "$s" 6 leases); hb=$(field "$s" 7 leases)
    # Over-age (taken over even though the sprite's own lock is fresh) only when still renewed: a lease that lapsed is
    # merely stale, and the sprite's lock decides, as it may belong to a run that took the sprite without the coordinator.
    if [ -n "$started" ] && [ $(( now - started )) -gt "$max_age" ] && [ -n "$hb" ] && [ $(( now - hb )) -le "$stale" ]; then age=$(( (now - started) / 60 )); holder=$(field "$s" 3 leases); fi
    id=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n'); put "$s" "$s $id $owner $ref $fp $now $now"; echo "lease $s $id $age $holder"
  done ;;
heartbeat) # <sprite> <id> ...: renew each, or say it was lost (released, or taken over after going stale)
  while [ $# -ge 2 ]; do
    if [ "$(field "$1" 2 leases)" = "$2" ]; then put "$1" "$(awk -v s="$1" -v t="$now" '$1 == s { $7 = t; print }' "$d/leases")"; echo "ok $1"; else echo "lost $1"; fi
    shift 2
  done ;;
release) # <sprite> <id> <fingerprint|-> ...: drop each lease; record what the sprite is synced at, and when
  while [ $# -ge 3 ]; do
    [ "$(field "$1" 2 leases)" != "$2" ] || put "$1" ""
    if [ "$3" != - ]; then { awk -v s="$1" '$1 != s' "$d/synced"; echo "$1 $3 $now"; } > "$d/synced.new"; mv "$d/synced.new" "$d/synced"; fi
    shift 3
  done ;;
stats) # <stale> <max-age> <prefix>: the leases of that pool, their ages, and the commits it is synced at (--stats)
  awk -v now="$now" -v stale="$1" -v max_age="$2" -v prefix="$3" '
    index($1, prefix) == 1 {
      n++; ref[$4]++; age = now - $6
      if (now - $7 <= stale) live++; else if (max_age != "" && age > max_age) old++; else lapsed++
      if (age > oldest) { oldest = age; who = $1 } }
    END {
      printf "leases: %d (%d live, %d lapsed, %d over-age)\n", n, live, lapsed, old
      if (n) printf "oldest: %s, held %ds\n", who, oldest
      for (r in ref) printf "  %s: %d\n", (r == "-" ? "held by another run (not a lease)" : r), ref[r] }' "$d/leases"
  awk -v prefix="$3" 'index($1, prefix) == 1 { c[substr($2, 1, 12)]++ }
    END { for (s in c) printf "  %s  %d sprite(s)\n", s, c[s] }' "$d/synced" ;;
reap) # <days> <prefix>: sprites of that pool no lease holds and nothing has synced in that many days
  cutoff=$(( now - $1 * 86400 ))
  awk -v cutoff="$cutoff" -v prefix="$2" 'index($1, prefix) == 1 { at[$1] = $3 }
    END { for (s in at) print s, at[s] }' "$d/synced" | while read -r s at; do
    [ -z "$(field "$s" 7 leases)" ] || continue
    if [ -n "$at" ] && [ "$at" -ge "$cutoff" ]; then continue; fi
    printf '  %-12s %s\n' "$s" "$( [ -n "$at" ] && echo "last synced $(( (now - at) / 86400 ))d ago" || echo 'last synced: not recorded' )"
  done ;;
hold) # <sprite> <id> <holder>: the sprite's own lock is someone else's; keep it out of acquire for a stale period
  [ "$(field "$1" 2 leases)" != "$2" ] || put "$1" "$1 held $3 - - $now $now" ;;
list) # <stale> <max-age> <prefix>
  awk -v now="$now" -v stale="$1" -v max_age="$2" -v prefix="$3" 'index($1, prefix) == 1 { n++; printf "%-14s %-13s %-50s %-10s %6ss old, heartbeat %ss ago%s\n", $1, $2, $3, $4, now - $6, now - $7, (now - $6 > max_age ? " (over-age: free)" : now - $7 > stale ? " (lapsed: free)" : "") }
    END { if (!n) print "(no leases)" }' "$d/leases" ;;
esac
EOF

# A pool sprite's side: remote <dir> <op> <args...>, with the checkout at ~/<dir>.
read -r -d '' REMOTE <<'EOF' || true
dir=$HOME/$1; op=$2; shift 2
api=/.sprite/bin/sprite-env
mine() { [ "$(cut -d' ' -f1 ~/lease/owner 2>/dev/null)" = "$1" ]; }
case $op in
claim) # <lease> <owner> <stale> [held-minutes] [holder]: take ~/lease. The last line is "claimed <synced fingerprint>" or "held <holder> <age>".
  mkdir -p ~/runs "$dir"
  if mine "$1"; then touch ~/lease
  elif ! mkdir ~/lease 2>/dev/null; then
    age=$(( $(date +%s) - $(stat -c %Y ~/lease 2>/dev/null || date +%s) ))
    holder=$(cut -d' ' -f2 ~/lease/owner 2>/dev/null); holder=${holder:-unknown}
    if [ -z "${4:-}" ] && [ "$age" -le "$3" ]; then echo "held $holder ${age}s"; exit 0; fi
    # The lease is stale or over-age: stop what it left (a job, or an old version's service and task).
    pid=$(cat ~/lease/pid 2>/dev/null) && kill -TERM -- "-$pid" 2>/dev/null
    for s in $($api services list 2>/dev/null | grep -o 'sprite-test-[0-9-]*' | sort -u); do $api services delete "$s" >/dev/null 2>&1; done
    $api curl -X DELETE /v1/tasks/sprite-test >/dev/null 2>&1
    mv ~/lease ~/lease.dead.$$ 2>/dev/null && rm -rf ~/lease.dead.$$
    mkdir ~/lease 2>/dev/null || { echo "held someone-else 0s"; exit 0; }
    # Whoever held it may have changed the checkout: sync it again.
    rm -f ~/.synced
    [ -n "${4:-}" ] || echo "== $(hostname): took over a stale lease of $holder (idle ${age}s)"
  fi
  [ -z "${4:-}" ] || echo "== $(hostname): took over an over-age lease of $5, held $4 min"
  echo "$1 $2" > ~/lease/owner
  find ~/runs -type f -mtime +7 -delete 2>/dev/null  # logs a week old go
  echo "claimed $(cat ~/.synced 2>/dev/null || echo -)" ;;
running) # <id>: "done" once the job wrote its exit status, "dead" if it went without one (a restart), else "running"
  if [ -e ~/runs/"$1".exit ]; then echo done
  elif pid=$(cat ~/runs/"$1".pid 2>/dev/null) && kill -0 "$pid" 2>/dev/null; then echo running; else echo dead; fi ;;
touch) mine "$1" && touch ~/lease ;;
unlock) ! mine "$1" || rm -rf ~/lease ;;
clean) # <kept...>: before a tar sync, every file but the kept paths goes (rsync exclude syntax: name/ or /path/)
  cd "$dir" || exit 0
  set -- "$@"; prune=
  for k in "$@"; do k=${k%/}; case $k in /*) prune="$prune -o -path .$k" ;; *) prune="$prune -o -name $k" ;; esac; done
  # shellcheck disable=SC2086
  find . \( -false $prune \) -prune -o ! -type d -exec rm -f {} +
  true ;;
start) # <id> <fingerprint> <job script, base64> <lease>: record the synced tree, start the job detached, wait until it runs.
  if [ -s ~/runs/"$1".pid ] && kill -0 "$(cat ~/runs/"$1".pid)" 2>/dev/null; then echo started; exit 0; fi
  # Never next to another run's job: two once shared a sprite, one's build deleting the other's binary.
  mine "$4" || { echo "the sprite's lock is $(cut -d' ' -f2 ~/lease/owner 2>/dev/null || echo gone), not this run's"; exit 1; }
  rm -f ~/runs/"$1".pid ~/runs/"$1".exit; echo "$3" | base64 -d > ~/runs/"$1".sh
  # A restarted sprite can lose its last writes: flush the tree before ~/.synced vouches for it.
  sync; echo "$2" > ~/.synced; sync
  (cd "$dir" && exec nohup setsid bash ~/runs/"$1".sh < /dev/null > /dev/null 2>&1 &)
  for _ in $(seq 50); do
    if [ -e ~/runs/"$1".exit ] || { [ -s ~/runs/"$1".pid ] && kill -0 "$(cat ~/runs/"$1".pid)" 2>/dev/null; }; then echo started; exit 0; fi
    sleep 0.1
  done
  echo "the job did not start"; exit 1 ;;
poll) # <id> <offset> <wait>: a status line (the exit status, "-" while it runs, "dead" if it died without one), then the
  # log from offset. A long poll: it returns once the log has grown past offset (gathering 2 s more of it), the job has
  # ended, or <wait> seconds have passed.
  log=~/runs/"$1".log; start=$(date +%s); grew=
  while :; do
    now=$(date +%s)
    [ ! -e ~/runs/"$1".exit ] || break
    pid=$(cat ~/runs/"$1".pid 2>/dev/null) && kill -0 "$pid" 2>/dev/null || break
    if [ "$(stat -c %s "$log" 2>/dev/null || echo 0)" -gt "$2" ]; then
      grew=${grew:-$now}; [ $(( now - grew )) -lt 2 ] || break; sleep 0.5
    else
      [ $(( now - start )) -lt "$3" ] || break
      inotifywait -qq -t 1 -e modify -e create -e moved_to ~/runs >/dev/null 2>&1 || sleep 0.2
    fi
  done
  s=$(cat ~/runs/"$1".exit 2>/dev/null) || s=
  if [ -z "$s" ]; then pid=$(cat ~/runs/"$1".pid 2>/dev/null) || pid=; if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then s=$(cat ~/runs/"$1".exit 2>/dev/null) || s=dead; fi; fi
  echo "${s:--}"; tail -c +$(( $2 + 1 )) ~/runs/"$1".log 2>/dev/null | head -c 1000000; true ;;
stop) # <id>: stop the job (it writes 137 and lets go of the lock)
  pid=$(cat ~/runs/"$1".pid 2>/dev/null) && kill -TERM -- "-$pid" 2>/dev/null; true ;;
status)
  holder=$(cut -d' ' -f2 ~/lease/owner 2>/dev/null); age=$(( $(date +%s) - $(stat -c %Y ~/lease 2>/dev/null || date +%s) ))
  echo "$(cut -c1-12 ~/.synced 2>/dev/null || echo -) ${holder:+locked by $holder, refreshed ${age}s ago}" ;;
esac
EOF

# The job, after its settings (id lease lock build hours max_age artifacts apt pg_env pg_port), `set -- <command>` and
# the repo's prepare step as repo_prepare(). It starts in the checkout, detached.
read -r -d '' JOB <<'EOF' || true
echo $$ > ~/runs/$id.pid; [ ! -d ~/lease ] || echo $$ > ~/lease/pid
exec > ~/runs/$id.log 2>&1 < /dev/null
api=/.sprite/bin/sprite-env; hold=; checkout=$PWD
finish() {
  [ -z "$hold" ] || kill "$hold" 2>/dev/null
  # Capture while we still own the checkout; ~/runs is outside it.
  if [ -n "$artifacts" ] && [ -d "$checkout/$artifacts" ]; then
    tar czf ~/runs/$id.artifacts.tar.gz -C "$checkout/$artifacts" . || { echo '== artifact snapshot failed'; set -- 1; }
  fi
  echo "$1" > ~/runs/$id.exit.new && mv ~/runs/$id.exit.new ~/runs/$id.exit
  if [ "$(cut -d' ' -f1 ~/lease/owner 2>/dev/null)" = "$lease" ]; then $api curl -X DELETE /v1/tasks/sprite-test >/dev/null 2>&1; rm -rf ~/lease; fi
  exit 0
}
cmd=
stop_job() {
  trap '' TERM INT HUP
  echo "== stopped"
  if [ -n "$cmd" ]; then
    # Give the command time to close what it started before the lease goes and the next job resets the sprite.
    kill -TERM "$cmd" 2>/dev/null
    for _ in $(seq 70); do kill -0 "$cmd" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$cmd" 2>/dev/null || true
  fi
  finish 137
}
trap stop_job TERM INT HUP
# Without a task the sprite pauses a few seconds after the last exec ends, and the job with it. The task lasts 5 minutes
# and is renewed every minute, with the lock, until the job ends.
job_pid=$$
(while kill -0 "$job_pid" 2>/dev/null && [ ! -e ~/runs/$id.exit ] && [ "$(cut -d' ' -f1 ~/lease/owner 2>/dev/null)" = "$lease" ] && [ "$SECONDS" -lt "$max_age" ]; do touch -c ~/lease; $api curl -X PUT /v1/tasks/sprite-test -d '{"expire":"5m"}' >/dev/null 2>&1; sleep 60; done) & hold=$!
# Node 22 first, as CI runs it (Node 23 and later change node:sqlite and the test runner's defaults).
export PATH=$HOME/.node22/bin:$PATH TERM=dumb
for v in $pg_env; do export "$v=postgres://postgres:test@127.0.0.1:$pg_port/postgres"; done

# Once per sprite, and again when the package list changes (~/.setup-core names it): packages and Node 22.
setup() (
  set -e
  echo "== setting up this sprite: packages ($apt) and Node 22"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null
  # shellcheck disable=SC2086
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xz-utils inotify-tools $apt >/dev/null 2>&1
  case $(uname -m) in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "== no Node 22 for $(uname -m)"; exit 1 ;; esac
  t=$(mktemp -d); cd "$t"
  curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  file=$(awk -v suffix="-linux-$arch.tar.xz" 'index($2, suffix) { print $2 }' SHASUMS256.txt)
  curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$file"
  grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet
  rm -rf ~/.node22 && mkdir -p ~/.node22 && tar xJf "$file" -C ~/.node22 --strip-components=1
  cd ~ && rm -rf "$t"
  # A Postgres this script once ran natively (before the container) only takes memory now.
  sudo service postgresql stop >/dev/null 2>&1 || true
  sync; echo "core-1 $apt" > ~/.setup-core
)

# Docker, set up once per sprite. A sprite has no systemd, so dockerd is a sprite-env service (it starts at boot and
# restarts on a crash), with overlay2 on the sprite's own /var/lib/docker volume and the classic image store, the default
# bridge kept, and the socket in this user's group (no sudo). A sprite's root has no CAP_SYS_PTRACE and its kernel no
# xt_socket; measured 2026-11-06 (kernel 6.12.115-fly, Docker 29.1.3), with plain, bridge and `--network container:<id>`
# containers and `docker exec` as root and as uid 1000:
#   Ubuntu's runc 1.4 (and 1.2.8, 1.3.3): a container in another's network namespace fails to start ("error spawning
#     mount remapping thread: ... open /proc/<pid>/ns/mnt: permission denied").
#   crun 1.21 --cgroup-manager=disabled: those start, but a bridge container hangs in Created, and exec as non-root fails.
#   runc 1.1.15 (the last 1.1, without that mount-source thread): all of them work, once the container's own process
#     runs. Until then its init (runc:[2:INIT]) is not dumpable, so an exec in that window fails ("failed to open
#     /proc/<pid>/ns/ipc: Permission denied", then "error executing setns process"); workerd execs at once after start.
# So runc 1.1.15, checked against its release's checksum, is the default runtime, behind a wrapper whose `start` returns
# once the container's process runs. Still impossible here: `docker exec` into a container whose process is not root
# (probe readiness over TCP), and starting a bridge container whose image starts as non-root (`USER`, `-u`). The
# daemon's configuration and the wrapper are the marker: a sprite whose /etc/docker/daemon.json or wrapper differs (none
# yet, or older ones) is set up again.
docker_up() {
  # An older camel-bots sprite-test marked its setup with a file ~/.docker, where the docker CLI keeps its config directory.
  [ ! -f ~/.docker ] || rm -f ~/.docker
  dir=/usr/local/lib/sprite-docker; runc=$dir/runc-1.1.15
  want=$(printf '{\n  "group": "%s",\n  "features": { "containerd-snapshotter": false },\n  "storage-driver": "overlay2",\n  "runtimes": { "runc-1.1": { "path": "%s" } },\n  "default-runtime": "runc-1.1",\n  "live-restore": true,\n  "log-driver": "local",\n  "log-opts": { "max-size": "10m", "max-file": "3" }\n}' "$(id -gn)" "$dir/runc")
  wrapper=$(cat <<'WRAPPER'
#!/bin/sh
# Docker's runtime on a sprite (scripts/sprite-test-core.sh): runc 1.1.15, whose `start` returns once the
# container's process runs, so an exec right after it can join the container's namespaces.
runc=/usr/local/lib/sprite-docker/runc-1.1.15
sub= root= skip= last=
for arg in "$@"; do
  last=$arg
  if [ -n "$skip" ]; then [ "$skip" = root ] && root=$arg; skip=; continue; fi
  [ -z "$sub" ] || continue
  case $arg in
    --root) skip=root ;;
    --log|--log-format|--criu|--rootless) skip=1 ;;
    -*) ;;
    *) sub=$arg ;;
  esac
done
[ "$sub" = start ] || exec "$runc" "$@"
"$runc" "$@" || exit
pid=$("$runc" ${root:+--root "$root"} state "$last" 2>/dev/null | sed -n 's/^ *"pid": *\([0-9]*\).*/\1/p')
[ -n "$pid" ] || exit 0
# Until it execs the container's process, runc's init is named runc:[2:INIT] (its comm, readable without ptrace).
for _ in $(seq 200); do case $(cat "/proc/$pid/comm" 2>/dev/null) in runc:*) sleep 0.05 ;; *) exit 0 ;; esac; done
exit 0
WRAPPER
)
  if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$want" ] || [ "$(cat "$dir/runc" 2>/dev/null)" != "$wrapper" ] || [ ! -x "$runc" ] \
    || ! command -v docker >/dev/null || ! docker buildx version >/dev/null 2>&1; then
    echo '== setting up Docker on this sprite'
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-buildx >/dev/null 2>&1 \
      || { sudo apt-get update -qq >/dev/null 2>&1 && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-buildx >/dev/null 2>&1; } \
      || { echo '== apt could not install Docker'; return 1; }
    case $(uname -m) in
      x86_64) sum=d218e1f8be4dcb1f288dea754faee342375a36f695eac5ab37fc8b7270a78763 arch=amd64 ;;
      aarch64) sum=c680f8c470ffb228944ca80e1a4dbb6768b3ad97057350852e128847f9dd10bc arch=arm64 ;;
      *) echo "== no runc 1.1.15 for $(uname -m)"; return 1 ;;
    esac
    echo "$sum  $runc" | sha256sum -c --quiet >/dev/null 2>&1 \
      || { sudo mkdir -p "$dir" && sudo curl -fsSL -o "$runc.new" "https://github.com/opencontainers/runc/releases/download/v1.1.15/runc.$arch" \
        && echo "$sum  $runc.new" | sha256sum -c --quiet && sudo chmod 755 "$runc.new" && sudo mv "$runc.new" "$runc"; } \
      || { echo '== could not install runc 1.1.15'; sudo rm -f "$runc.new"; return 1; }
    printf '%s\n' "$wrapper" | sudo tee "$dir/runc" >/dev/null && sudo chmod 755 "$dir/runc" || return 1
    # Stop whatever runs now (the service, or a daemon started by hand), then start the service on the new configuration.
    $api services stop docker >/dev/null 2>&1; sudo pkill -x dockerd 2>/dev/null; sleep 1
    sudo mkdir -p /etc/docker && printf '%s\n' "$want" | sudo tee /etc/docker/daemon.json >/dev/null || return 1
    $api services get docker >/dev/null 2>&1 \
      || $api services create docker --cmd /usr/bin/sudo --args /usr/bin/dockerd --no-stream >/dev/null 2>&1
    $api services start docker >/dev/null 2>&1
  fi
  for i in $(seq 60); do timeout -k 2 10 docker info >/dev/null 2>&1 && break; [ "$i" != 10 ] || $api services start docker >/dev/null 2>&1; sleep 1; done
  timeout -k 2 10 docker info >/dev/null 2>&1 \
    || { echo '== Docker is not running (sprite-env services list; /.sprite/logs/services/docker.log)'; return 1; }
  # The lease owns the sprite: any container still here is an earlier run's.
  ids=$(docker ps -aq); [ -z "$ids" ] || timeout -k 2 60 docker rm -f $ids >/dev/null 2>&1 || true
}

# One fresh Postgres per run, as CI runs it (.github/actions/test-postgres): postgres:16-alpine, a tmpfs data directory
# (the sprite's disks are slow to sync; it halved camel-bots' full run and removed its load flakes), durability off,
# 1000 connections. Host networking on a fixed port; readiness over TCP, as `docker exec` into it would fail (its server
# runs as uid 70). On CI a connection reaches the container through Docker's bridge and so needs the password; here it
# comes from 127.0.0.1, which the image's initdb would trust, and a test of a wrong password then passed it
# (agent-runtime's tests/db.test.ts, rotating credentials). So TCP connections need the password here too.
pg_up() {
  docker image inspect postgres:16-alpine >/dev/null 2>&1 || timeout -k 2 300 docker pull -q postgres:16-alpine >/dev/null || return 1
  docker run -d --name sprite-test-pg --network host --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_PASSWORD=test -e POSTGRES_DB=postgres -e PGPORT="$pg_port" -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
    postgres:16-alpine -p "$pg_port" -c max_connections=1000 -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null \
    || { echo '== the Postgres container did not start'; return 1; }
  for _ in $(seq 120); do timeout -k 2 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$pg_port" 2>/dev/null && return 0; sleep 0.5; done
  echo "== Postgres is not accepting connections on $pg_port"; docker logs --tail 20 sprite-test-pg 2>&1 | tail -5; return 1
}

prepare() {
  [ "$(cat ~/.setup-core 2>/dev/null)" = "core-1 $apt" ] && [ -x ~/.node22/bin/node ] || setup || return 1
  # The base image's ~/.bashrc binds keys even when not interactive, so every `bash -l` warns on stderr (and tests that
  # read a login shell's stderr fail): bind only in interactive shells.
  sed -i "s/^bind '/[[ \$- == *i* ]] \&\& bind '/" ~/.bashrc
  docker_up || return 1
  pg_up || return 1
  # npm ci again when package-lock.json or Node changed.
  mark="$lock $(node -v)"
  [ "$(cat ~/.lock 2>/dev/null)" = "$mark" ] || { echo '== npm ci (package-lock.json or Node changed)'; npm ci --silent --no-audit --no-fund && sync && echo "$mark" > ~/.lock; } || return 1
  # In a subshell, so a cd or a variable there does not leak into the command.
  ( repo_prepare ) || { echo "== the repo's prepare step failed"; return 1; }
}
prepare || { echo '== preparing the sprite failed'; finish 1; }
cd "$checkout"; echo "== $*"
# timeout runs the command in a process group of its own, so a stop reaches it through the trap above.
timeout "${hours}h" "$@" & cmd=$!
wait "$cmd"; finish $?
EOF

# limit <seconds> <command...>: the command, ended by SIGALRM after <seconds>.
limit() { perl -e 'alarm shift; exec @ARGV or die' "$@"; }
coord() { limit 20 sprite exec -o "$org" -s "$coordinator" --no-stdin -- bash -c "$COORD" coord "$@"; }
remote() { local name=$1 secs=$2; shift 2; limit "$secs" sprite exec -o "$org" -s "$name" --no-stdin -- bash -c "$REMOTE" remote "$sprite_dir" "$@"; }
ssh_cmd="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes -o ProxyCommand=\"sprite proxy -o $org -s %h --ssh\""
candidates=(${SPRITE_NAME:-$(for i in $(seq "$pool"); do echo "$sprite_prefix$i"; done)})
prefix=$sprite_prefix
rsync_keep=(); for k in ${sprite_keep:-node_modules/}; do rsync_keep+=("--exclude=$k"); done

case ${1:-} in
-h|--help) usage; exit 0 ;;
--status)
  echo "== leases (coordinator $coordinator)"
  coord list "$stale_s" "$max_age" "$prefix" 2>/dev/null || echo "(the coordinator could not be reached)"
  echo "== sprites: synced commit, lock"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  for i in "${!candidates[@]}"; do remote "${candidates[i]}" 30 status > "$tmp/$i" 2>/dev/null & done
  wait
  for i in "${!candidates[@]}"; do
    sha=; rest=; read -r sha rest < "$tmp/$i" || true
    subject=$( [[ -z $sha || $sha = - ]] || git log --oneline -1 "$sha" 2>/dev/null | cut -c1-60 || true)
    printf '%-12s %s %s\n' "${candidates[i]}" "${subject:-${sha:-(unreachable)}}" "$rest"
  done
  exit 0 ;;
--fetch)
  name=${2:-}; from=${3:-}; to=${4:-}
  { [[ -n $name && -n $from ]] && grep -qx "$name" <<<"$(sprite list -o "$org" 2>/dev/null)" ; } || {
    echo "== --fetch takes a sprite and a path: --fetch ${prefix}4 '~/runs/<id>.log' ./run.log" >&2; exit 2; }
  [[ -n $to ]] || to=./$(basename "${from%/}")
  # rsync, not `sprite file pull`: 60 ms a file there, about 8 MB/s here.
  limit 600 rsync -az --timeout=20 -e "$ssh_cmd" "sprite@$name:${from#~/}" "$to" || {
    echo "== could not fetch $name:$from (a path must be relative to the sprite's home: ~/runs/...)" >&2; exit 1; }
  echo "== fetched $name:$from to $to"; exit 0 ;;
--stats)
  list=$(sprite list -o "$org" 2>/dev/null || true)
  echo "== the pool: $(printf '%s\n' "$list" | grep -c "^$prefix") $prefix* sprites (SPRITE_POOL=$pool)"
  coord stats "$stale_s" "$max_age" "$prefix" 2>/dev/null || echo "(the coordinator could not be reached)"
  exit 0 ;;
--reap)
  days=${2:-${SPRITE_REAP_DAYS:-14}}
  [[ $days =~ ^[0-9]+$ ]] || { echo "== --reap takes a number of days: --reap 30" >&2; exit 2; }
  echo "== sprites no lease holds and nothing has synced in $days days (deleting one is yours: sprite delete -o $org <name>)"
  coord reap "$days" "$prefix" 2>/dev/null || echo "(the coordinator could not be reached)"
  exit 0 ;;
--grow)
  n=${2:-1}; [[ $n =~ ^[1-9][0-9]*$ ]] || { echo "== --grow takes a count: --grow 4" >&2; exit 2; }
  list=$(sprite list -o "$org" 2>/dev/null || true)
  max=$(printf '%s\n' "$list" | grep -o "^${prefix}[0-9]\\+" | sed "s/^${prefix}//" | sort -n | tail -1); max=${max:-0}
  made=()
  for i in $(seq $(( max + 1 )) $(( max + n ))); do
    name=$prefix$i; made+=("$name"); echo "== creating $name"
    sprite create -o "$org" --skip-console "$name" >/dev/null 2>&1 || true
    grep -qx "$name" <<<"$(sprite list -o "$org" 2>/dev/null)" || { echo "== $name did not appear in the pool; stopping" >&2; exit 1; }
  done
  echo "== warming ${made[*]}"; exec env SPRITE_NAME="${made[*]}" bash "$0" --warm ;;
esac

warm=0; dirty=0; command_shards=; artifacts=; artifact_output=
while [[ ${1:-} == --* ]]; do
  case $1 in
    --warm) warm=1 ;;
    --shards=*) command_shards=${1#*=} ;;
    --artifacts=*) artifacts=${1#*=} ;;
    --output=*) artifact_output=${1#*=} ;;
    --dirty) dirty=1 ;;
    --targeted)
      shift
      (( $# )) || { echo 'usage: scripts/sprite-test --targeted tests/a.test.ts [tests/b.test.ts ...]' >&2; exit 2; }
      set -- HEAD node --experimental-strip-types --disable-warning=ExperimentalWarning --test "$@"
      break ;;
    *) if declare -F sprite_option >/dev/null && sprite_option "$1"; then :; else echo "Unknown sprite-test option: $1 (scripts/sprite-test --help)" >&2; exit 2; fi ;;
  esac
  shift
done
if [[ -n $command_shards ]] && { [[ ! $command_shards =~ ^[1-9][0-9]*$ ]] || (( command_shards > pool )); }; then
  echo "--shards must be between 1 and SPRITE_POOL ($pool)" >&2; exit 2
fi
if [[ -n $artifacts ]]; then
  [[ $artifacts != /* && $artifacts != *..* && $artifacts =~ ^[a-zA-Z0-9_./-]+$ && -n $artifact_output ]] || { echo '--artifacts needs a safe relative directory and --output' >&2; exit 2; }
  mkdir -p "$artifact_output"; artifact_output=$(cd "$artifact_output" && pwd)
fi
ref=${1:-HEAD}; shift || true
(( ! warm )) || set --
(( ! (warm && dirty) )) || { echo "== --dirty runs a command; it has nothing to send with --warm" >&2; exit 2; }

# --dirty's deny-list: secrets never leave the laptop, whether or not .gitignore covers them. Matched on the file's name.
dirty_denied() {
  local base=${1##*/}
  case $base in *.example|*.sample|*.template) return 1 ;; esac  # committed templates, by convention without secrets
  case $base in
    .env|.env.*|*.env|.dev.vars|.dev.vars.*|*.pem|*.key|*.p12|*.pfx|*.tfvars|*.tfvars.json|credentials|credentials.json|credentials.yml|credentials.yaml|credentials.toml|credentials.ini|credentials.csv|*.credentials|*.credentials.json|*-credentials.json|.netrc|.npmrc|.pypirc) return 0 ;;
    id_*.*) [[ $base == *.pub ]] && return 0; return 1 ;;  # an SSH key's public half too; id_util.ts is code
    id_*) return 0 ;;                          # id_rsa, id_ed25519, ...: no extension
  esac
  return 1
}
if (( dirty )); then
  # The working tree as it is, without committing it or touching the real index: a temporary index takes the working tree
  # (`git add -A`, so new files come too and .gitignore still applies), and `commit-tree` writes one commit and no ref.
  # A changed path the deny-list names keeps its committed version (or stays out, if it is new), and is listed.
  index=$(mktemp -u "${TMPDIR:-/tmp}/sprite-test-index.XXXXXX"); rm -f "$index"
  base=$(git rev-parse "$ref^{commit}")
  GIT_INDEX_FILE=$index git read-tree "$base"; GIT_INDEX_FILE=$index git add -A || { rm -f "$index"; exit 1; }
  skipped=()
  while IFS= read -r -d '' path; do
    dirty_denied "$path" || continue
    skipped+=("$path")
    if git cat-file -e "$base:$path" 2>/dev/null; then GIT_INDEX_FILE=$index git reset -q "$base" -- "$path"
    else GIT_INDEX_FILE=$index git rm -q --cached -- "$path"; fi
  done < <(GIT_INDEX_FILE=$index git diff --cached --name-only -z "$base")
  tree=$(GIT_INDEX_FILE=$index git write-tree); rm -f "$index"
  (( ! ${#skipped[@]} )) || { echo "== --dirty: kept these off the sprite (secrets deny-list; they run as committed, or not at all):" >&2; printf '     %s\n' "${skipped[@]}" >&2; }
  if [[ $tree = $(git rev-parse "$base^{tree}") ]]; then
    echo "== --dirty: nothing differs from $ref, so that is what runs" >&2; sha=$base
  else
    ident=(); [[ -n $(git config user.name || true) ]] || ident+=(-c user.name=sprite-test); [[ -n $(git config user.email || true) ]] || ident+=(-c user.email=sprite-test@localhost)
    sha=$(git "${ident[@]}" commit-tree "$tree" -p "$base" -m "dry: working tree at $(date -u +%Y-%m-%dT%H:%M:%SZ)")
  fi
else
  sha=$(git rev-parse --verify "$ref^{commit}")
fi
short=$(git rev-parse --short "$sha")
lock=$(git rev-parse "$sha:package-lock.json")
build=-; [[ -z ${sprite_build_path:-} ]] || build=$(git rev-parse "$sha:$sprite_build_path")
fp=$sha:$lock:$build
run=$(date +%Y%m%d-%H%M%S)-$$; owner=$(whoami)@$(hostname -s)/$run
# One command per slot. The full pass (no command) runs as SPRITE_SHARDS shards at once, each on its own sprite, its
# output prefixed [i/N] as it comes. --warm takes every free sprite the coordinator does not record at the commit.
shards=${SPRITE_SHARDS:-$sprite_shards}; [[ $shards =~ ^[0-9]+$ ]] || { echo "SPRITE_SHARDS must be a number" >&2; exit 2; }
if (( warm )); then slots=${#candidates[@]}
elif [[ -n $command_shards ]]; then slots=$command_shards
elif [[ $# -eq 0 && $shards -gt 1 ]]; then slots=$shards
else slots=1; fi
args=("$@")
job_for() { # <slot> <lease> <id>: the job script, base64
  local cmd arg expanded=()
  if (( warm )); then cmd=true
  elif (( ${#args[@]} )); then
    for arg in "${args[@]}"; do arg=${arg//\{shard\}/$1}; arg=${arg//\{shards\}/$slots}; expanded+=("$arg"); done
    cmd=$(printf '%q ' "${expanded[@]}")
  else cmd=$(sprite_default_job "$1" "$slots"); fi
  {
    printf 'id=%q lease=%q lock=%q build=%q hours=%q max_age=%q artifacts=%q apt=%q pg_env=%q pg_port=%q\n' \
      "$3" "$2" "$lock" "$build" "${SPRITE_RUN_HOURS:-2}" "$max_age" "$artifacts" "${sprite_apt:-}" "$sprite_pg_env" "$pg_port"
    [[ -z ${sprite_sha_env:-} ]] || printf 'export %s=%q\n' "$sprite_sha_env" "$sha"
    printf 'repo_prepare() {\n%s\ntrue\n}\nset -- %s\n%s\n' "${sprite_prepare:-true}" "$cmd" "$JOB"
  } | base64 | tr -d '\n'
}

tmp=$(mktemp -d); : > "$tmp/leases"; echo coordinator > "$tmp/mode"
names=() leases=() synced=() workers=() beat=
cleanup() { [[ -z $beat ]] || { pkill -P "$beat" 2>/dev/null; kill "$beat" 2>/dev/null; } || true; rm -rf "$tmp"; }
trap cleanup EXIT
# Until the jobs start, this script keeps their sprites' locks fresh; the coordinator leases are renewed throughout.
(
  # Its own stderr stays quiet ("Terminated" when the cleanup stops its sleep); notices go to the script's, on fd 3.
  exec 3>&2 2>/dev/null
  until=$(( SECONDS + max_age ))
  while sleep 60; kill -0 $$ 2>/dev/null && (( SECONDS < until )); do
    [[ -s $tmp/leases ]] || continue
    renew=()
    while read -r name lease; do
      [[ ! -e $tmp/done.$name ]] || continue
      if [[ -e $tmp/started.$name ]] && [[ $(remote "$name" 30 running "$(cat "$tmp/job.$name")") = "done" ]]; then
        touch "$tmp/done.$name"
        [[ $(cat "$tmp/mode") != coordinator ]] || coord release "$name" "$lease" - >/dev/null
      else renew+=("$name" "$lease"); fi
    done < "$tmp/leases"
    if [[ ${#renew[@]} -gt 0 && $(cat "$tmp/mode") = coordinator ]] && coord heartbeat "${renew[@]}" > "$tmp/beat" 2>/dev/null; then
      while read -r verdict name; do
        [[ $verdict = lost && ! -e $tmp/lost.$name ]] || continue
        touch "$tmp/lost.$name"; echo "== the coordinator lease on $name was lost (not renewed for ${stale_s}s); the job still holds the sprite's lock" >&3
      done < "$tmp/beat"
    fi
    while read -r name lease; do [[ -e $tmp/started.$name ]] || remote "$name" 30 touch "$lease" >/dev/null 2>&1 & done < "$tmp/leases"
    wait
  done
) & beat=$!

claim() { # <name> <lease> [held-minutes holder]: prints "ok <synced>" or "no <why>". A sprite that doesn't answer gets a
  # second try: waking a stopped one can take a while, and several runs' execs at once have timed out.
  local out try err=$tmp/claim-err.$1
  for try in 1 2; do
    out=$(remote "$1" 90 claim "$2" "$owner" "$stale_s" "${3:-}" "${4:-}" 2> "$err") || true
    case ${out##*$'\n'} in claimed*|held*) break ;; esac
  done
  grep '^== ' <<<"$out" || true
  case ${out##*$'\n'} in
    claimed*) echo "ok ${out##*claimed }" ;;
    held*) echo "no ${out##*held }" ;;
    *) echo "no unreachable: $(grep -v '^ *$' "$err" | tail -1 | tr ' ' _ | cut -c1-120)" ;;
  esac
  rm -f "$err"
}
add() { names+=("$1"); leases+=("$2"); synced+=("$3"); echo "$1 $2" >> "$tmp/leases"; }
existing=$(sprite list -o "$org" 2>/dev/null || true)
create() { # <name>: a new sprite; a create that times out may still have made it, so it counts once the pool lists it
  echo "== creating $1"
  sprite create -o "$org" --skip-console "$1" >/dev/null 2>&1 || sprite list -o "$org" 2>/dev/null | grep -qx "$1"
}
pick=()  # the candidates that exist; a missing pool sprite is created only when every existing one is busy
for name in "${candidates[@]}"; do
  if grep -qx "$name" <<<"$existing"; then pick+=("$name"); elif [[ -n ${SPRITE_NAME:-} ]] && create "$name"; then pick+=("$name"); fi
done
waited=0 announced=0 current=0
while (( ${#names[@]} < slots )); do
  missing=$(( slots - ${#names[@]} )); busy=; held=0
  if [[ $(cat "$tmp/mode") = coordinator ]]; then
    want=$missing; (( ! warm )) || want=any:$missing
    code=0; out=$(coord acquire "$want" "$stale_s" "$max_age" "$fp" "$owner" "$short" "${pick[@]}" 2>&1) || code=$?
    if (( code != 0 && code != 75 )) && ! grep -qx "$coordinator" <<<"$existing"; then
      create "$coordinator" || true; existing=$(sprite list -o "$org" 2>/dev/null || true)
      code=0; out=$(coord acquire "$want" "$stale_s" "$max_age" "$fp" "$owner" "$short" "${pick[@]}" 2>&1) || code=$?
    fi
    if (( code != 0 && code != 75 )); then
      echo fallback > "$tmp/mode"; echo "== the coordinator $coordinator could not be reached; probing the sprites one by one (their ~/lease locks alone)" >&2
      continue
    fi
    current=$(grep -c '^current ' <<<"$out" || true)
    got=($(awk '$1 == "lease" { print $2 ":" $3 ":" $4 ":" $5 }' <<<"$out")); busy=$(awk '$1 == "busy" { print "   " $2 ": " $3 ", renewed " $4 " ago" }' <<<"$out")
    # Claim them all at once. One whose own lock is someone else's goes back to the coordinator as held.
    pids=()
    for i in "${!got[@]}"; do
      IFS=: read -r name lease age holder <<<"${got[i]}"
      claim "$name" "$lease" "$age" "$holder" > "$tmp/claim.$i" & pids+=($!)
    done
    for p in "${pids[@]}"; do wait "$p" || true; done
    for i in "${!got[@]}"; do
      IFS=: read -r name lease age holder <<<"${got[i]}"; grep '^== ' "$tmp/claim.$i" || true
      verdict=; rest=; read -r verdict rest < <(grep -v '^== ' "$tmp/claim.$i") || true
      if [[ $verdict = ok ]]; then add "$name" "$lease" "$rest"
      else coord hold "$name" "$lease" "${rest// /_}" >/dev/null 2>&1 || true; held=1; echo "== $name is still in use (${rest}); taking another"; fi
    done
    (( ! held )) || continue
  else
    for name in "${pick[@]}"; do
      (( ${#names[@]} < slots )) || break
      [[ " ${names[*]-} " != *" $name "* ]] || continue
      lease=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
      claim "$name" "$lease" > "$tmp/claim"; grep '^== ' "$tmp/claim" || true
      verdict=; rest=; read -r verdict rest < <(grep -v '^== ' "$tmp/claim") || true
      if [[ $verdict = ok ]]; then add "$name" "$lease" "$rest"; else busy+="   $name: $rest"$'\n'; fi
    done
  fi
  (( ${#names[@]} < slots && ! warm )) || break
  # Not enough free sprites: create a pool sprite that doesn't exist yet, else wait.
  created=
  for name in "${candidates[@]}"; do
    grep -qx "$name" <<<"$existing" && continue
    create "$name" && { pick+=("$name"); existing+=$'\n'$name; created=1; break; }
  done
  [[ -z $created ]] || continue
  (( waited < wait_s )) || { echo "== not enough free sprites (${prefix}1..$pool in $org) for $(( wait_s / 60 )) minutes; raise SPRITE_POOL or SPRITE_WAIT_MINUTES" >&2; exit 75; }
  (( announced )) || { echo "== waiting for $missing free sprite(s), up to $(( wait_s / 60 )) minutes${busy:+. In use:}"; [[ -z $busy ]] || printf '%s\n' "$busy"; announced=1; }
  sleep 30; waited=$(( waited + 30 ))
done
mode=$(cat "$tmp/mode")
if (( warm && ! ${#names[@]} && current )); then echo "== the $current free sprites are already at $short"; exit 0; fi
(( ${#names[@]} )) || { echo "== no free sprite to warm" >&2; exit 75; }

# Every sprite gets the tree from here, or checks its own against it (a fraction of a second to write).
tree=$tmp/tree; mkdir "$tree"; git archive "$sha" | tar x -C "$tree"
! declare -F sprite_tree >/dev/null || sprite_tree "$tree"

worker() { # <slot index>: sync, start the job, follow it. Writes the exit status to tmp/code.<slot>, the synced fingerprint to tmp/fp.<slot>.
  local k=$1 name=${names[$1]} lease=${leases[$1]} id t0=$SECONDS t1 how out attempt=0 verdict rest
  echo - > "$tmp/fp.$k"; echo 1 > "$tmp/code.$k"
  while :; do
    attempt=$(( attempt + 1 )); id=$run-$(( k + 1 )); (( attempt == 1 )) || id+=-$attempt; echo "$id" > "$tmp/id.$k"; t1=$SECONDS
    # Sprites' API answers 429 when many execs start at once: a failed sync or start is tried again, after a pause.
    # A sync now and then stalls before ssh is up, where rsync's --timeout doesn't reach: each try gets 2 minutes.
    how=
    for try in 1 2 3; do
      if limit 120 rsync -az --delete --stats --timeout=20 "${rsync_keep[@]}" -e "$ssh_cmd" "$tree/" "sprite@$name:$sprite_dir/" > "$tmp/rsync.$k" 2>&1; then
        how=rsync; ! grep -q 'transferred file size: 0 B' "$tmp/rsync.$k" || how="in sync (checked by rsync)"; break
      fi
      grep -v 'bind: warning' "$tmp/rsync.$k" | tail -2; (( try == 3 )) || sleep $(( try * 10 ))
    done
    if [[ -z $how ]]; then
      echo "== rsync to $name failed; sending the tree as a tar stream instead"
      # shellcheck disable=SC2086
      if remote "$name" 120 clean ${sprite_keep:-node_modules/} && tar czf - -C "$tree" . | limit 600 sprite exec -o "$org" -s "$name" --stdin -- sh -c "cd ~/$sprite_dir && tar xzf -"; then how=tar
      else echo "== could not send the tree to $name"; remote "$name" 30 unlock "$lease" >/dev/null 2>&1 || true; return; fi
    fi
    for try in 1 2 3; do
      out=$(remote "$name" 60 start "$id" "$fp" "$(job_for $(( k + 1 )) "$lease" "$id")" "$lease" 2>&1) && break
      # A lock gone between the claim and the start (a sprite restart can drop the last writes; seen 2026-11-06): claim
      # it again and start. One that another run holds stays theirs.
      if [[ $out == *"lock is gone, not this run's"* ]] && (( try < 3 )); then
        verdict=; rest=; read -r verdict rest < <(claim "$name" "$lease" | grep -v '^== ') || true
        [[ $verdict = ok ]] && continue
      fi
      [[ $out != *"not this run's"* ]] || { out="failed: $out"; break; }
      out="failed: $out"; (( try == 3 )) || sleep $(( try * 10 ))
    done
    if [[ $out = failed:* ]]; then
      echo "== could not start the job on $name: $out"; remote "$name" 30 unlock "$lease" >/dev/null 2>&1 || true; return
    fi
    echo "$id" > "$tmp/job.$name"; touch "$tmp/started.$name"; echo "$fp" > "$tmp/fp.$k"
    echo "== sprite-test $(git log --oneline -1 "$sha" | cut -c1-80) on $name ($id): $how, started in $(( SECONDS - t1 ))s"
    # Long polls: each waits on the sprite up to 50 s for new output or the end. A failed poll is only a blip, the job
    # carries on and the next poll reads from the same offset. After SPRITE_LOST_MINUTES with no answer, leave it running.
    local chunk=$tmp/chunk.$k offset=0 answered=$SECONDS status=- size
    while :; do
      if remote "$name" 90 poll "$id" "$offset" 50 > "$chunk" 2>/dev/null; then
        answered=$SECONDS; IFS= read -r status < "$chunk" || status=-
        size=$(( $(wc -c < "$chunk") - ${#status} - 1 )); (( size > 0 )) || size=0
        tail -n +2 "$chunk"; offset=$(( offset + size ))
        (( size >= 1000000 )) && continue
        [[ $status = - ]] || break
      elif (( SECONDS - answered >= lost_s )); then
        echo "== lost contact with $name; the job carries on. Log ~/runs/$id.log, status ~/runs/$id.exit there"; echo 69 > "$tmp/code.$k"; return
      else sleep 5; fi
    done
    [[ $status = dead ]] || break
    # Sprites now and then restarts a sprite: its processes go, and so can the last writes before it. Claim it again,
    # sync again (~/.synced may be gone with them) and run the job once more (SPRITE_RETRIES, default 1).
    echo "== the job died without an exit status: the sprite restarted under it"
    (( attempt <= ${SPRITE_RETRIES:-1} )) || { status=137; break; }
    rm -f "$tmp/started.$name"; out=$(claim "$name" "$lease"); verdict=; rest=; read -r verdict rest < <(grep -v '^== ' <<<"$out") || true
    [[ $verdict = ok ]] || { echo "== could not claim $name again ($rest)"; status=137; break; }
    synced[k]=$rest; echo "== running it again on $name (retry $attempt of ${SPRITE_RETRIES:-1})"
  done
  if [[ -n $artifacts && $status != 69 ]]; then
    mkdir -p "$artifact_output/shard-$(( k + 1 ))"
    local copied=
    for try in 1 2 3; do
      if limit 120 rsync -a --timeout=20 -e "$ssh_cmd" "sprite@$name:runs/$id.artifacts.tar.gz" "$tmp/artifacts.$k.tar.gz"; then copied=1; break; fi
      (( try == 3 )) || sleep $(( try * 2 ))
    done
    if [[ -n $copied ]] && tar xzf "$tmp/artifacts.$k.tar.gz" -C "$artifact_output/shard-$(( k + 1 ))"; then
      echo "== collected artifacts from $name into $artifact_output/shard-$(( k + 1 ))"
    else echo "== could not collect artifacts from $name"; status=1; fi
  fi
  echo "== exit $status in $(( SECONDS - t0 ))s on $name; log ~/runs/$id.log there"
  echo "$status" > "$tmp/code.$k"
}

release() {
  [[ -z $beat ]] || { pkill -P "$beat" 2>/dev/null; kill "$beat" 2>/dev/null; wait "$beat" 2>/dev/null; beat=; } || true
  [[ $mode = coordinator ]] || return 0
  local i rel=()
  for i in "${!names[@]}"; do rel+=("${names[i]}" "${leases[i]}" "$(cat "$tmp/fp.$i" 2>/dev/null || echo -)"); done
  coord release "${rel[@]}" >/dev/null 2>&1 || echo "== could not release the leases; they lapse in ${stale_s}s" >&2
}
stopping() {
  trap '' INT TERM HUP
  echo "== stopping the jobs" >&2
  kill "${workers[@]}" 2>/dev/null || true
  local i pids=()
  for i in "${!names[@]}"; do
    if [[ -e $tmp/started.${names[i]} ]]; then remote "${names[i]}" 30 stop "$(cat "$tmp/id.$i")" >/dev/null 2>&1 &
    else remote "${names[i]}" 30 unlock "${leases[i]}" >/dev/null 2>&1 & fi
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; done
  release; exit 130
}
trap stopping INT TERM HUP

for k in "${!names[@]}"; do
  if (( slots == 1 && ! warm )); then worker "$k" &
  elif (( warm )); then worker "$k" > >(sed -u "s/^/[${names[k]}] /") 2>&1 &
  else worker "$k" > >(sed -u "s/^/[$(( k + 1 ))\/$slots] /") 2>&1 & fi
  workers+=($!)
done
for p in "${workers[@]}"; do wait "$p" || true; done
release
status=0 ready=0
for k in "${!names[@]}"; do
  code=$(cat "$tmp/code.$k" 2>/dev/null || echo 1)
  if (( code == 0 )); then ready=$(( ready + 1 )); elif (( status == 0 || status == 69 )); then status=$code; fi
done
sleep 0.2  # the prefixing seds
if (( warm )); then echo "== $ready of ${#names[@]} sprites ready at $short$( (( ! current )) || echo ", $current were already") (busy ones were left alone)"; exit 0; fi
exit "$status"
