"""A labelled turn-taking set for scripts/voice-turns-eval.ts: clips from pipecat's Smart Turn test set
(pipecat-ai/smart-turn-data-v3.1-test, CC-BY-4.0), balanced per language and label, as 16 kHz mono 16-bit WAV with an
index.json of {file, language, complete, dataset, synthetic, seconds}.

  python3 scripts/voice-turns-dataset.py <out dir> [per language and label, default 20] [shard, default 0]

Needs numpy, pyarrow and soundfile. Downloads one parquet shard (~480 MB, 23 languages, ~3,500 clips) into the out dir.
"""
import io, json, os, sys, collections, urllib.request
import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

out = sys.argv[1]
per = int(sys.argv[2]) if len(sys.argv) > 2 else 20
shard = int(sys.argv[3]) if len(sys.argv) > 3 else 0
os.makedirs(out, exist_ok=True)
parquet = os.path.join(out, f"shard-{shard}.parquet")
if not os.path.exists(parquet):
    url = f"https://huggingface.co/api/datasets/pipecat-ai/smart-turn-data-v3.1-test/parquet/default/train/{shard}.parquet"
    print("downloading", url)
    urllib.request.urlretrieve(url, parquet)

table = pq.read_table(parquet)
counts = collections.Counter()
index = []
for batch in table.to_batches(max_chunksize=200):
    for row in batch.to_pylist():
        key = (row["language"], row["endpoint_bool"])
        if counts[key] >= per:
            continue
        audio, rate = sf.read(io.BytesIO(row["audio"]["bytes"]), dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)
        if rate != 16000:
            n = int(round(len(audio) * 16000 / rate))
            audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
        name = f"{row['language']}-{'c' if row['endpoint_bool'] else 'i'}-{row['id'][:8]}.wav"
        sf.write(os.path.join(out, name), audio, 16000, subtype="PCM_16")
        counts[key] += 1
        index.append({"file": name, "language": row["language"], "complete": row["endpoint_bool"], "dataset": row["dataset"],
                      "synthetic": row["synthetic"], "seconds": round(len(audio) / 16000, 2)})
with open(os.path.join(out, "index.json"), "w") as f:
    json.dump(index, f, indent=0)
print(len(index), "clips,", sum(1 for i in index if i["complete"]), "complete,", len({i["language"] for i in index}), "languages")
