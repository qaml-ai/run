#!/usr/bin/env bash
# Store a dedicated OpenRouter API key for tools.search ranking by meaning (embeddings, then Jev),
# then roll the ECS service. Optional: without it, search uses the platform's OpenRouter key
# (platformKeys.openrouter in the tenants secret). A dedicated key keeps search spend on its own
# (https://openrouter.ai/settings/keys, with a monthly limit; a search costs about $0.00015).
#
# Usage: infra/tool-search.sh   (reads the key from stdin)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

[[ $# -eq 0 ]] || { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ ! -t 0 ]] || echo "Paste the OpenRouter API key and press Enter, then Ctrl-D:" >&2
umask 077
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
python3 -c 'import sys
lines = [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
if len(lines) != 1: sys.exit("Send one line: the OpenRouter API key")
if not lines[0].startswith("sk-or-"): sys.exit("That is not an OpenRouter API key (sk-or-...)")
open(sys.argv[1], "w").write(lines[0])' "$work/key"
id="$SECRET_PREFIX/tool-search"
if aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$id" --secret-string "file://$work/key" >/dev/null
else
  aws secretsmanager create-secret --name "$id" --description "OpenRouter API key for tools.search ranking by meaning (embeddings and Jev). Set with infra/tool-search.sh." --secret-string "file://$work/key" >/dev/null
fi
echo "Stored $id."
# Tasks read this secret at startup; roll the service so new tasks pick it up.
aws ecs update-service --region "$REGION" --cluster "$NAME" --service "$NAME" --force-new-deployment >/dev/null
echo "Rolling the ECS service to turn on tool search ranking by meaning."
