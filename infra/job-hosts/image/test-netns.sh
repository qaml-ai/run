#!/usr/bin/env bash
# The job host's network rules and egress proxy, checked for real without a VM (docs/design/job-hosts-plan.md, slice 6).
# Network namespaces stand in for the host and two job VMs:
#   camel-host:  the host. It holds the base rules (files/camel-host.nft), job taps cj0 and cj1 (veth ends), the egress
#                proxy (as uid 940, like the real host's), a stand-in for IMDS (169.254.169.254), a host service on :22,
#                and an "internet" server at 203.0.113.10:443 (a TEST-NET address, public to the proxy's checks).
#   camel-job0, camel-job1: two guests, at 10.200.0.2 and 10.200.1.2, as their inits set them.
#   camel-net:   the world past the host's own interface: IMDS (169.254.169.254) and an "internet" server
#                (203.0.113.10, a TEST-NET address the proxy's checks count as public).
# Needs root (sudo), ip, nft and node. It changes nothing outside its own namespaces, and removes them at exit.
#   sudo infra/job-hosts/image/test-netns.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
node=${NODE:-$(command -v node)}
[[ $(id -u) == 0 ]] || { echo "Run as root (sudo)." >&2; exit 2; }
H=camel-host J0=camel-job0 J1=camel-job1 N=camel-net
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  # Whatever still runs in the namespaces (a backgrounded function's child outlives its subshell's pid).
  for ns in $H $J0 $J1 $N; do ip netns pids "$ns" 2>/dev/null | xargs -r kill -9 2>/dev/null || true; done
  for ns in $H $J0 $J1 $N; do ip netns del "$ns" 2>/dev/null || true; done
  rm -rf "${work:-}"
}
trap cleanup EXIT
work=$(mktemp -d)
chmod 755 "$work"
# The proxy's user (uid 940) reads nothing under a home directory: it runs a copy of node and of the proxy's files.
mkdir -p "$work/jobhost"; cp "$node" "$work/node"; cp "$repo/jobhost/egress-proxy.ts" "$repo/jobhost/network.ts" "$work/jobhost/"
node=$work/node
for ns in $H $J0 $J1 $N; do ip netns del "$ns" 2>/dev/null || true; ip netns add "$ns"; ip -n "$ns" link set lo up; done
inh() { ip netns exec $H "$@"; }

# The host: forwarding on (so "nothing is forwarded" is the rules' doing, not the kernel's default), job taps as veths.
inh sysctl -qw net.ipv4.ip_forward=1
for slot in 0 1; do
  ns=camel-job$slot
  ip link add "cj$slot" netns $H type veth peer name eth0 netns "$ns"
  inh ip addr add "10.200.$slot.1/30" dev "cj$slot"; inh ip link set "cj$slot" up
  ip -n "$ns" addr add "10.200.$slot.2/30" dev eth0; ip -n "$ns" link set eth0 up
  ip -n "$ns" route add default via "10.200.$slot.1"
done
# The host's own interface (ens5 on EC2) to the world: IMDS and the internet server live past it.
ip link add ens5 netns $H type veth peer name up0 netns $N
inh ip addr add 192.0.2.1/24 dev ens5; inh ip link set ens5 up
ip -n $N addr add 192.0.2.2/24 dev up0; ip -n $N link set up0 up
ip -n $N addr add 169.254.169.254/32 dev lo; ip -n $N addr add 203.0.113.10/32 dev lo
inh ip route add 169.254.169.254/32 via 192.0.2.2; inh ip route add 203.0.113.10/32 via 192.0.2.2
ip -n $N route add 10.200.0.0/16 via 192.0.2.1
# Stand-ins: a host service, IMDS and an internet server (each answers with its name and the line it got).
serve() { ip netns exec "$1" "$node" -e "require('net').createServer(s=>s.on('data',d=>{s.end('$3:'+d)})).listen($2,'${4:-0.0.0.0}')" & pids+=($!); }
serve $H 22 ssh
serve $J1 22 job1
serve $N 80 imds 169.254.169.254
serve $N 443 imds443 169.254.169.254
serve $N 443 internet 203.0.113.10
# NO_RULES=1 leaves the rules out, to see the checks fail without them (the suite's own control).
[[ ${NO_RULES:-} == 1 ]] || inh nft -f "$here/files/camel-host.nft"

# The proxy as the host runs it (uid 940), its names resolved by a fixed table instead of Amazon's DNS.
mkdir -p "$work/egress"
cat > "$work/proxy.mjs" <<EOF
import { egressProxy } from "$work/jobhost/egress-proxy.ts";
const names = { "allowed.test": ["203.0.113.10"], "other.test": ["203.0.113.10"], "rebind.test": ["169.254.169.254"] };
egressProxy({ policyDir: "$work/egress", lookup: async host => names[host] ?? [] }).listen(3128, "0.0.0.0", () => console.log("proxy up"));
EOF
"$node" --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module -e "
  const { writePolicy } = await import('$work/jobhost/egress-proxy.ts');
  await writePolicy('$work/egress', '10.200.0.2', { job: 'job0', allow: ['allowed.test', 'rebind.test'] });
  await writePolicy('$work/egress', '10.200.1.2', { job: 'job1', allow: [] });"
chmod -R a+rX "$work"
inh setpriv --reuid=940 --regid=940 --clear-groups "$node" --experimental-strip-types --disable-warning=ExperimentalWarning "$work/proxy.mjs" & pids+=($!)
for _ in $(seq 50); do ip netns exec $J0 "$node" -e "require('net').connect(3128,'10.200.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && break; sleep 0.2; done

failed=0
expect() { # expect <ok|refused|forbidden> <name> <namespace> <command...>; forbidden: the proxy's own 403 (exit 3)
  local want=$1 name=$2 ns=$3; shift 3
  local out code=0; out=$(ip netns exec "$ns" timeout 5 "$@" 2>&1) || code=$?
  case $code in 0) got=ok;; 3) got=forbidden;; *) got=refused;; esac
  if [[ $got == "$want" ]]; then echo "ok    $name"; else echo "FAIL  $name (wanted $want, got $got: ${out:0:160})"; failed=1; fi
}
tcpto() { echo "probe" | "$node" -e "const s=require('net').connect($2,'$1');s.setTimeout(3000,()=>process.exit(1));s.on('error',()=>process.exit(1));s.on('data',d=>{process.stdout.write(d);process.exit(0)});process.stdin.pipe(s)"; }
connect() { # connect <proxy> <target> <expect-body>: CONNECT through the proxy, send a line, read the echo
  "$node" -e "
    const s=require('net').connect(3128,'$1'); let buf='';
    s.setTimeout(4000,()=>process.exit(1)); s.on('error',()=>process.exit(1));
    s.write('CONNECT $2 HTTP/1.1\r\nHost: $2\r\n\r\n');
    s.on('data',d=>{buf+=d; if(/^HTTP\/1.1 200/.test(buf)&&!buf.includes('internet:')){ if(buf.endsWith('\r\n\r\n')) s.write('hello\n'); }
      if(buf.includes('$3')) process.exit(0); if(/^HTTP\/1.1 403/.test(buf)) process.exit(3); });"
}
export -f tcpto connect; export node

expect ok      "an allowlisted host is reachable through the proxy"           $J0 bash -c "connect 10.200.0.1 allowed.test:443 internet:hello"
expect forbidden "a host off the allowlist is refused"                          $J0 bash -c "connect 10.200.0.1 other.test:443 internet:"
expect forbidden "a name resolving to IMDS is refused (rebinding)"              $J0 bash -c "connect 10.200.0.1 rebind.test:443 imds443:"
expect forbidden "an IP literal target is refused"                              $J0 bash -c "connect 10.200.0.1 169.254.169.254:443 imds443:"
expect forbidden "a port other than 443 is refused"                             $J0 bash -c "connect 10.200.0.1 allowed.test:80 internet:"
expect forbidden "a job without internet reaches nothing through the proxy"     $J1 bash -c "connect 10.200.1.1 allowed.test:443 internet:"
expect refused "IMDS is unreachable directly"                                 $J0 bash -c "tcpto 169.254.169.254 80"
expect refused "the internet is unreachable except through the proxy"         $J0 bash -c "tcpto 203.0.113.10 443"
expect refused "the host's other services are unreachable"                    $J0 bash -c "tcpto 10.200.0.1 22"
expect refused "another job's VM is unreachable"                              $J0 bash -c "tcpto 10.200.1.2 22"
expect refused "another job's tap is unreachable"                             $J0 bash -c "tcpto 10.200.1.1 3128"
ip -n $J0 addr add 10.200.1.2/32 dev eth0
expect refused "passing for another job's address gets nothing"               $J0 bash -c "\"$node\" -e \"const s=require('net').connect({port:3128,host:'10.200.0.1',localAddress:'10.200.1.2'});s.setTimeout(3000,()=>process.exit(1));s.on('error',()=>process.exit(1));s.on('connect',()=>process.exit(0))\""
# The proxy's own user cannot reach IMDS or the host's loopback even by address (the rules, not only its checks).
expect refused "the proxy's user cannot reach IMDS"                           $H setpriv --reuid=940 --regid=940 --clear-groups bash -c "tcpto 169.254.169.254 443"
expect refused "the proxy's user cannot reach loopback services"              $H setpriv --reuid=940 --regid=940 --clear-groups bash -c "tcpto 127.0.0.1 22"
expect ok      "the proxy's user reaches a public address on 443"             $H setpriv --reuid=940 --regid=940 --clear-groups bash -c "tcpto 203.0.113.10 443"
expect ok      "the host itself still reaches IMDS (its agent attests with it)" $H bash -c "tcpto 169.254.169.254 80"
exit $failed
