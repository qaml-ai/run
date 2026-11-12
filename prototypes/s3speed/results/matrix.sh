#!/bin/bash
set -e
cd /nvme/s3speed; exec 2>>/nvme/s3speed/stderr.log
S=camel-fs-proto-904534089871-usw2; X=camel-fs-proto-cache--usw2-az4--x-s3
out=matrix.csv; hdr=--csv-header; : > $out
sar -n DEV 1 > sar.txt 2>&1 & SAR=$!
for rep in 1 2; do
for b in $S $X; do for s in 50m:254 500m:2438; do for m in chunk pack1m pack4m range4m; do for c in 4 16 32 64 128; do
  ./s3speed fetch --bucket $b --prefix s3speed/${s%%:*} --chunks ${s##*:} --mode $m --concurrency $c --out /nvme/s3speed/out.bin --label full-${s%%:*}-r$rep $hdr >> $out; hdr=
done; done; done
# 10% subset of 500m (cold job start), warm client and cold client
for m in chunk pack1m pack4m range4m; do for c in 16 64 128; do
  ./s3speed fetch --bucket $b --prefix s3speed/500m --chunks 2438 --subset 0.1 --subset-seed $((rep+10)) --mode $m --concurrency $c --out /nvme/s3speed/out.bin --label sub10-500m-r$rep >> $out
done; done
for m in chunk range4m; do
  ./s3speed fetch --bucket $b --prefix s3speed/500m --chunks 2438 --subset 0.1 --subset-seed $((rep+20)) --mode $m --concurrency 64 --cold-client --out /nvme/s3speed/out.bin --label sub10cold-500m-r$rep >> $out
done
done; done
kill $SAR
for b in $S $X; do for k in 4 256; do for r in 1 2 3; do ./s3speed latency --bucket $b --prefix s3speed/lat --size-kib $k --n 200 --label lat-r$r $([ $b = $S ] && [ $k = 4 ] && [ $r = 1 ] && echo --csv-header); done; done; done > latency.csv
echo done
