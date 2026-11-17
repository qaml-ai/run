import json, os, pathlib, signal, subprocess, tempfile, time
script=(pathlib.Path.cwd()/"camelfsd/scripts/warm-repo-pair.sh").resolve()
output=pathlib.Path.cwd()/"work/warmrepo-lifecycle"
output.mkdir(parents=True,exist_ok=True)
receipts=[]
with tempfile.TemporaryDirectory(prefix="warmrepo-shell-test-") as tmp:
    base=pathlib.Path(tmp)
    fake=base/"bin"
    fake.mkdir()
    stub=base/"probe"
    stub.write_text("""#!/usr/bin/env bash
set -euo pipefail
mode=$1
shift
data=
while (( $# )); do
  case "$1" in
    --data) data=$2; shift 2 ;;
    *) shift ;;
  esac
done
case "$mode" in
  seed|fill)
    mkdir -p "$data/repo.git"
    printf '{}\\n' > "$data/manifest.json"
    dirname "$data" > "$PROBE_TEST_TRACE/state"
    printf '{"event":"fake_fixture"}\\n'
    ;;
  serve)
    printf '%s\\n' "$$" > "$PROBE_TEST_TRACE/server.pid"
    exec sleep 300
    ;;
  *) exit 2 ;;
esac
""")
    stub.chmod(0o700)
    go=fake/"go"
    go.write_text("""#!/usr/bin/env bash
set -euo pipefail
mkdir -p work/warmrepo-results
cp "$PROBE_TEST_STUB" work/warmrepo-results/warm-repo-probe
chmod 700 work/warmrepo-results/warm-repo-probe
""")
    go.chmod(0o700)
    python=fake/"python3"
    python.write_text("#!/usr/bin/env sh\ncat >/dev/null\n")
    python.chmod(0o700)
    runroot=base/"checkout"
    runroot.mkdir()
    results=runroot/"work/warmrepo-results"
    results.mkdir(parents=True)
    (results/"STOP").touch()
    for name in ["first","rerun","term"]:
        trace=base/name
        trace.mkdir()
        env=dict(os.environ,PATH=str(fake)+os.pathsep+os.environ["PATH"],
                 PROBE_TEST_STUB=str(stub),PROBE_TEST_TRACE=str(trace))
        logpath=output/(name+".log")
        with logpath.open("w") as log:
            proc=subprocess.Popen(["bash",str(script),"server"],cwd=runroot,env=env,
                                  stdout=log,stderr=subprocess.STDOUT)
            try:
                deadline=time.monotonic()+5
                while not (trace/"server.pid").exists():
                    if proc.poll() is not None:
                        raise AssertionError(name+" exited before server start: "+logpath.read_text())
                    if time.monotonic()>deadline:
                        raise AssertionError(name+" failed to start within 5s")
                    time.sleep(0.02)
                pid=int((trace/"server.pid").read_text())
                state=pathlib.Path((trace/"state").read_text().strip())
                time.sleep(0.1)
                assert proc.poll() is None, name+" consumed a stale STOP"
                assert not (results/"STOP").exists(), name+" retained stale STOP"
                assert state.is_dir(), name+" missing active temporary state"
                if name=="term":
                    proc.send_signal(signal.SIGTERM)
                    expected=143
                else:
                    (results/"STOP").touch()
                    expected=0
                code=proc.wait(timeout=5)
                assert code==expected,(name,code,expected,logpath.read_text())
                assert not state.exists(), name+" left temporary fixture data"
                try:
                    os.kill(pid,0)
                except ProcessLookupError:
                    pass
                else:
                    raise AssertionError(name+" left server process "+str(pid))
                receipts.append({"case":name,"exit":code,"serverReaped":True,
                                 "temporaryStateRemoved":True,"staleStopRemoved":True})
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
(output/"results.json").write_text(json.dumps(receipts,indent=2)+"\n")
print(json.dumps({"event":"warm_repo_script_lifecycle","cases":receipts}))

