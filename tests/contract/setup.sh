#!/usr/bin/env bash
# Source this file so the isolated Python environment remains on PATH.
# sprite-test owns root dependencies, Postgres, and the v8-exec build.
set -euo pipefail
contract_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
contract_cache=${CONTRACT_SETUP_CACHE:-${HOME}/rt-cache/contract/setup}
mkdir -p "$contract_cache"
contract_python_key=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()+sys.version.encode()).hexdigest())' "$contract_root/clients/python/requirements.txt")
contract_python="$contract_cache/python-$contract_python_key"
if [[ ! -f $contract_python/.ready || ! -x $contract_python/bin/python3 ]]; then
  echo '== contract setup: installing Python requirements'
  rm -rf "$contract_python"
  python3 -m venv "$contract_python"
  "$contract_python/bin/python3" -m pip install --quiet -r "$contract_root/clients/python/requirements.txt"
  touch "$contract_python/.ready"
else
  echo '== contract setup: reusing Python requirements'
fi
export PATH="$contract_python/bin:$PATH"
if [[ ${1:-both} != node ]]; then
  contract_workers_key=$(node --input-type=module -e 'import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; const h=createHash("sha256"); for(const p of process.argv.slice(1))h.update(readFileSync(p)); console.log(h.update(process.version).update(process.platform).update(process.arch).digest("hex"))' "$contract_root/backends/workers/package.json" "$contract_root/backends/workers/package-lock.json")
  contract_workers_marker="$contract_root/backends/workers/node_modules/.contract-lock"
  if [[ ! -x $contract_root/backends/workers/node_modules/.bin/wrangler || $(cat "$contract_workers_marker" 2>/dev/null || true) != "$contract_workers_key" ]]; then
    echo '== contract setup: installing Workers dependencies'
    npm ci --prefix "$contract_root/backends/workers" --silent --no-audit --no-fund
    printf '%s\n' "$contract_workers_key" > "$contract_workers_marker"
  else
    echo '== contract setup: reusing Workers dependencies'
  fi
fi
