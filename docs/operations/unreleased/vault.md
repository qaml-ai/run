### Vault credentials and limited Workers networking

Tenant and workspace vault APIs store write-only credentials under the existing secrets key. Workers computers can substitute attached placeholders at HTTPS egress; remote tool sources can reference vault credentials. `networking` limits Workers computer destinations. Node/Sprites refuses limited networking. See `docs/guides/vault.md`.

Child agents inherit network and secret boundaries. GitHub App git traffic streams without response masking; vault response masking applies only to text. Body substitution requires `inBody: true`, while header-only requests stream without a body cap. Reserved runtime environment names and values shorter than eight characters are refused. `scripts/verify-egress.mjs` checks an existing pilot Container without changing configuration.
