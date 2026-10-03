# Exporting your data

`GET /v1/account/export` (the console's **Account → Export data**) answers with a
zip of everything camelRun stores for your account. Any API token of the account
can call it; a browser token cannot.

```sh
curl -sf https://run.camelai.com/v1/account/export -H "Authorization: Bearer $CAMELAI_API_KEY" -o camelrun-export.zip
```

| In the zip | |
| --- | --- |
| `README.txt` | what each file is |
| `account.json` | your account's id, the identity you sign in with, when it was made and exported |
| `agents/<id>/agent.json` | each agent's configuration and schedules |
| `agents/<id>/history/*.json` | each agent's whole history, a page of whole turns per file, named by its first message's index |
| `definitions.json`, `channels.json`, `webhooks.json` | your definitions, channels and webhook endpoints (secrets and credentials left out or masked) |
| `tokens.json`, `keys.json` | your API tokens' names and prefixes, and which provider keys are set (last four characters): never a token or key |
| `oauth-grants.json`, `discord.json` | applications you let act for your account, and managed Discord bindings |
| `volumes/<id>/volume.json`, `volumes/<id>/files/…` | each volume's name and size, and its files |
| `billing/ledger.jsonl`, `billing/usage.json` | your credit ledger (newest first) and model usage per day and model |

**An export is whole, or it fails.** Each agent's history is read from the node
serving it, so it includes the turn that just ended. If anything cannot be read,
the download stops before the zip's end, so no zip reader opens it as complete
(`curl -f` fails, and `unzip` reports a missing central directory): export
again. A zip that opens holds every agent.

## Leaving, or moving to a self-hosted runtime

The runtime is open source, and [Self-hosting](../operations/self-host.md) runs
the same API on your own machines. **There is no import yet**: nothing loads an
export into another runtime in one step. To carry agents over by hand:

- **Configuration:** make each agent again from its `agent.json` (or each
  definition from `definitions.json`) with the same key, pointing the SDK at the
  new runtime (`CAMELAI_BASE_URL`).
- **History:** each `history/*.json` file is a list of `{index, message}`. Take
  the `message`s of every file, in order of the file names, and pass them as
  `initialMessages` when you make the agent; see [Bringing in existing
  conversations](multi-user.md#bringing-in-existing-conversations).
- **Files:** upload a volume's `files/` to a new volume.
- **Keys, tokens, channel credentials and webhook secrets** are not in the
  export: set them again.

To delete the account and everything in it, use **Delete account** on the
console's Account page.
