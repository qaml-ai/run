# Sourced by ec2-smoke.sh after the image smoke. Reuses its daemon and cleanup trap.
unit3() {
  if [[ ! -e /nvme/host-free ]]; then rec 'unit 3 skipped: /nvme/host-free is absent'; return; fi
  local report=$PWD/scripts/ec2-smoke-results.txt
  echo 'unit 3' | tee -a "$RESULT" "$report"
  local lineage=unit3-$(date +%s) t1 t2 p1 p2 response checkpoint image j
  t1=$(client import-tree --lineage "$lineage" --dir /nvme/bench/trees/medium | field tree)
  p1=$(printf "tree %s\nauthor smoke <smoke@camelfs> 1 +0000\ncommitter smoke <smoke@camelfs> 1 +0000\n\nseed\n" "$t1" | git hash-object -t commit --stdin)
  for j in j1 j2; do
    response=$(client mount --job "$j" --lineage "$lineage" --tree "$t1" --parent "$p1" --holder smoke --epoch 1 --vsock "$W/unit3-$j")
    echo "unit3 mount $j $response" | tee -a "$RESULT" "$report"
    image=$(field image <<<"$response")
    mount -o loop "$image" "$W/mnt"
    "$BIN" testguest apply --vsock-dir "$W/unit3-$j" --job "$j" --mount "$W/mnt" --index "$W/unit3-$j.idx.json"
    # Status records the guest's measured applyMs; wait for its reply to be processed.
    for ((a=0;a<100;a++)); do
      response=$(client status --job "$j")
      [[ $(field applied <<<"$response") == True ]] && break
      sleep .01
    done
    echo "unit3 apply $j $response" | tee -a "$RESULT" "$report"
    if [[ $j == j2 ]]; then
      for i in 0 1 2; do echo '// unit 3 changed' >> "$W/mnt/src/m0/d0/f$i.ts"; done
      mkdir -p "$W/unit3-git"
      git -C "$W/unit3-git" init -q
      GIT_DIR=$W/unit3-git/.git GIT_WORK_TREE=$W/mnt git add -A
      expected=$(GIT_DIR=$W/unit3-git/.git GIT_WORK_TREE=$W/mnt git write-tree)
    fi
    "$BIN" testguest checkpoint --vsock-dir "$W/unit3-$j" --job "$j" --mount "$W/mnt" --index "$W/unit3-$j.idx.json" &
    local guest=$!
    checkpoint=$("$BIN" client --socket "$SOCK" checkpoint --job "$j")
    wait "$guest"
    "$BIN" testguest checkpointed --tree "$(field tree <<<"$checkpoint")" --index "$W/unit3-$j.idx.json"
    echo "unit3 checkpoint $j $checkpoint" | tee -a "$RESULT" "$report"
    for key in walkMs streamMs freezeMs reflinkMs fiemapMs uploadMs publishMs imageMs wallMs checkpointMs; do
      echo "unit3 $j $key=$(field "$key" <<<"$checkpoint")" | tee -a "$RESULT" "$report"
    done
    if [[ $j == j1 ]]; then
      assert 'j["tree"]=="'"$t1"'" and j["filesChanged"]==0' <<<"$checkpoint"
    else
      assert 'j["filesChanged"]==3' <<<"$checkpoint"
      t2=$(field tree <<<"$checkpoint")
      p2=$(field commit <<<"$checkpoint")
      [[ $t2 == "$expected" ]]
      curl -fsS --unix-socket "$SOCK" "http://localhost/v0/trees/$t2" >/dev/null
    fi
    umount "$W/mnt"
    client release --job "$j" >/dev/null
  done
  response=$(client mount --job j3 --lineage "$lineage" --tree "$t2" --parent "$p2" --holder smoke --epoch 1 --vsock "$W/unit3-j3")
  assert 'j["warm"] is True and j["apply"] is None' <<<"$response"
  echo "unit3 tree mount $response" | tee -a "$RESULT" "$report"
  mount -o loop "$(field image <<<"$response")" "$W/mnt"
  "$BIN" testguest apply --vsock-dir "$W/unit3-j3" --job j3 --mount "$W/mnt" --index "$W/unit3-j3.idx.json"
  grep -q '^// unit 3 changed' "$W/mnt/src/m0/d0/f0.ts"
  umount "$W/mnt"; client release --job j3 >/dev/null
  rm -rf "$W/unit3-git"
  rm -f "$W"/unit3-*.json
  echo 'unit 3 PASS' | tee -a "$RESULT" "$report"
}
