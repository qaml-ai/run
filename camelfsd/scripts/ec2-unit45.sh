# Sourced by ec2-smoke.sh after unit3. Uses the existing store and daemon.
unit45() {
 [[ $MODE == clone ]] || return 0
 rec 'units 4–5'
 local img=$W/large.img imported root mounted dev start status state cp release
 truncate -s 4G "$img"
 mkfs.ext4 -q -E lazy_itable_init=0,lazy_journal_init=0 -F "$img"
 mount -o loop "$img" "$W/mnt"
 cp -a /nvme/bench/trees/large/. "$W/mnt/"
 sync; umount "$W/mnt"
 imported=$(client import-image --lineage large --name main --path "$img")
 rec "large_import $imported image_bytes=4294967296"
 root=$(field root <<<"$imported")
 rm -f "$D/images/$root.img"; rm -rf "$D/cache"
 start=$(now)
 mounted=$(client mount --job j3 --lineage large --ref main --vsock "$W/j3")
 dev=$(field image <<<"$mounted")
 (
  for ((i=0;i<3000;i++)); do
   status=$(client status --job j3); state=$(field state <<<"$status")
   if [[ $state == hydrated ]]; then elapsed "$start" > "$W/hydration-ms.txt";exit 0;fi
   sleep .1
  done
  exit 1
 ) &
 local hydration_poll=$!
 local first=$(now)
 mount -o loop "$dev" "$W/mnt"
 cat "$W/mnt/src/m0/d0/f0.ts" >/dev/null
 rec "first_file_ms=$(elapsed "$first")"
 first=$(now); tar cf - -C "$W/mnt" . | cat >/dev/null
 rec "full_read_during_hydration_ms=$(elapsed "$first")"
 wait "$hydration_poll"
 rec "hydration_ms=$(cat "$W/hydration-ms.txt")"

 first=$(now);tar cf - -C "$W/mnt" . | cat >/dev/null
 rec "full_read_after_ms=$(elapsed "$first")"
 for generation in 1 2; do
  for i in 0 1 2; do echo "// units 4–5 generation $generation" >> "$W/mnt/src/m0/d0/f$i.ts"; done
  sync;umount "$W/mnt"
  cp=$(client checkpoint --job j3)
  rec "cold_checkpoint_$generation $cp"
  assert 'j["hashMs"] < 100' <<<"$cp"
  mount -o loop "$dev" "$W/mnt"
 done
 umount "$W/mnt"
 first=$(now); release=$(client release --job j3)
 rec "releaseMs=$(elapsed "$first") release=$release"
 assert 'j["promoted"] is True' <<<"$release"
 # Mount the original root with an empty cache and no complete image.
 rm -f "$D/images/$root.img";rm -rf "$D/cache"
 mounted=$(client mount --job j3 --lineage large --root "$root" --hydrate=false)
 dev=$(field image <<<"$mounted")
 first=$(now);mount -o loop,ro "$dev" "$W/mnt"
 tar cf - -C "$W/mnt" . | cat >/dev/null
 rec "cold_full_read_ms=$(elapsed "$first") depth=64"
 umount "$W/mnt";client release --job j3 >/dev/null
 first=$(now);go test ./internal/image -run '^TestEvictionProtectsLiveFilesAndReachesLowWatermark$' -count=1
 rec "eviction_sweep_test_ms=$(elapsed "$first") (includes Go test startup)"
 # The 5k-file guest test logs the full freeze window through ack and thaw.
 bash scripts/ec2-freeze-compare.sh | tee -a "$RESULT"
 {
  echo; echo 'units 4–5'
  sed -n '/^units 4–5$/,$p' "$RESULT"
 } >> scripts/ec2-smoke-results.txt
}
