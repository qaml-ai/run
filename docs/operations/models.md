# Model operations

The platform's model keys, the Azure OpenAI deployments, which models are offered, and how to tell a slow or failing
model. Who pays for which key is in [Billing](billing.md); a tenant's own gateway is in
[Model endpoints](model-endpoints.md).

## Platform keys

The platform's provider keys are the top-level `platformKeys` of the tenants file: on the hosted runtime, the
Secrets Manager secret `camelai/agent-runtime/tenants` (`{"tenants": {...}, "platformKeys": {"anthropic": "...",
"openrouter": "...", "openai": "...", "exa": "..."}}`). A tenant without a key of its own for a provider falls back to
them: prepaid tenants are charged for it, unbilled admin tenants are recorded as platform usage, and an entry with
`"platformKeys": false` never uses them ([Tenants](tenants.md#billing-and-keys)). `platformKeys.openai` also makes
images and transcription, and is Azure's fallback (below).

`infra/tenant.sh` edits tenants, not `platformKeys`. To add or rotate one, edit the secret the way the script does,
with the key on stdin and nothing printed:

```sh
umask 077; f=$(mktemp)
aws secretsmanager get-secret-value --region us-west-2 --secret-id camelai/agent-runtime/tenants \
  --query SecretString --output text > "$f"
python3 -c '
import json, sys
path, provider = sys.argv[1], sys.argv[2]
key = sys.stdin.read().strip()
if not key: sys.exit("No key on stdin")
data = json.load(open(path))
data.setdefault("platformKeys", {})[provider] = key
json.dump(data, open(path, "w"))' "$f" openrouter     # paste the key, Enter, then Ctrl-D
aws secretsmanager put-secret-value --region us-west-2 --secret-id camelai/agent-runtime/tenants \
  --secret-string "file://$f" >/dev/null
rm -f "$f"
```

To see which providers have a platform key, without printing one:

```sh
aws secretsmanager get-secret-value --region us-west-2 --secret-id camelai/agent-runtime/tenants \
  --query SecretString --output text | python3 -c 'import json, sys; print(sorted(json.load(sys.stdin).get("platformKeys", {})))'
```

Every task re-reads the secret within 60 seconds; nothing restarts. Secrets Manager keeps the previous value as
`AWSPREVIOUS`, so a bad edit can be undone by putting that version back. Revoke an old key at the provider only
after a minute has passed.

Platform accounts with a balance (OpenRouter, Anthropic) refuse requests before they reach zero: a request is
refused when the balance cannot cover its full `max_tokens`. `-model-billing-errors` is the first sign
([Alarms](alarms.md#-model-billing-errors)).

## Azure OpenAI

The platform's Azure OpenAI resource serves two things, both from the secret `camelai/agent-runtime/azure-openai`
(`AGENT_AZURE_OPENAI_SECRET_ARN`, read at startup):

- **Images and transcription** made on the platform's OpenAI key go to its deployments (default
  `gpt-image-2.5-flare` and `gpt-transcribe`). When Azure is rate limited, down or lacks the deployment, the
  platform's OpenAI key makes them instead. A tenant's own OpenAI key stays on OpenAI.
- **The `azure/<model>` chat models** (`azure/gpt-6-sol`, `azure/gpt-6-luna`, ...) for tenants on the platform's keys,
  billed at OpenAI's price for the same model. Only the models the secret names are offered.

Store or change it with the resource's endpoint, its deployments and the models, with the key on stdin:

```sh
az cognitiveservices account keys list -g <resource group> -n <resource> --query key1 -o tsv \
  | infra/azure-openai.sh https://<resource>.cognitiveservices.azure.com gpt-image-2.5-flare gpt-transcribe \
      gpt-6-sol,gpt-6-luna=<deployment name>
```

- The script **replaces the whole secret**: pass every model each time (a model left out is no longer offered), and
  the image and transcription deployments before them, since the models are the fourth argument. `model=deployment`
  names a deployment; a bare model id is deployed under its own name.
- The secret must exist first (Terraform, `secrets.tf`). If the running task definition already reads it, the script
  force-rolls the service so tasks read the new value; otherwise it says to apply Terraform and deploy the running
  tag ([Deploys](deploys.md#settings-changes-ship-with-a-deploy)).
- Then check each deployment with one minimal call (well under a cent each); it prints one JSON line per model and
  exits 1 if any failed (401 key refused, 404 no such deployment, 429, a content filter):

  ```sh
  AWS_REGION=us-west-2 node --experimental-strip-types scripts/azure-models-check.ts \
    --secret camelai/agent-runtime/azure-openai [--only gpt-6-sol] [--dry-run]
  ```

  The key stays in memory and is never printed. `--dry-run` checks the settings without calling.
- After the roll, `GET /v1/models?provider=azure` lists the models stored, and the runtime's `images_generated` and
  `transcribed` log lines say `"via":"azure"`.

## Which models are offered

The catalog is Pi's model list plus the runtime's own entries and price fixes (`src/pi-catalog.ts`), and the
`azure/<model>` entries above. `GET /v1/models` lists it; `?available=true` lists what the calling tenant can use now
(its own keys, the platform's, its model endpoints). A model's price there is what usage, spend limits and billing
use, so a wrong catalog price is a billing bug: fix it in code with a release note, as for Sonnet 5.5's cache reads.

## Slow or failing models

The `AgentRuntime` metrics `TimeToFirstTokenMs`, `Turns`, `ModelRetries` and `ModelErrors` are published per
`Provider` and `Model`. [Logs and metrics](logs-and-metrics.md#which-models-are-slow-or-failing) has a ready query
that lists every model's p90 time to first token, turns, retries and errors over the last three hours, and the
`model_error` log lines say how each failure was classified. The alarms that watch them are `-first-token-slow`,
`-turn-failures`, `-model-rate-limited` and `-model-billing-errors` ([Alarms](alarms.md#turns-and-models)).

Interrupted model calls and how their usage is settled are in [Model attempt reconciliation](model-reconciliation.md).
