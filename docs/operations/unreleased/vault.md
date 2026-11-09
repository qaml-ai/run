### Vault credentials and limited Workers networking

Tenant and workspace vault APIs store write-only credentials under the existing secrets key. Workers computers can substitute attached placeholders at HTTPS egress; remote tool sources can reference vault credentials. `networking` limits Workers computer destinations. Node/Sprites refuses limited networking. See `docs/guides/vault.md`.
