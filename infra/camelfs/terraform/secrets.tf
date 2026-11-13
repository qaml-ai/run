# Secret container only. The value is set by infra/camelfs/jwks.sh, never by Terraform, so no key material enters
# Terraform state. Do not add aws_secretsmanager_secret_version resources here.
#
# Tokens (camel-fs.md §1.10) are EdDSA/Ed25519 JWTs (typ camelfs+jwt, aud camelrun:camelfs) signed by the runtime's
# existing signer (backends/workers/src/runtime-identity.ts: private keys sealed in its Postgres signing_keys,
# published at <runtime>/.well-known/jwks.json). The tier only verifies, from a copy of that public JWKS, and
# never calls the network for keys: the secret below holds the JWKS ({"keys":[{kty:"OKP", crv:"Ed25519", x, kid,
# alg:"EdDSA", use:"sig"}, ...]}, two keys during a rollover) and ECS injects it into the api task as the
# environment variable CAMELFS_JWKS (ecs.tf). The api task role cannot read the secret; only the execution role
# can, for the injection. A rotation is `jwks.sh set` then a roll of the service.

resource "aws_secretsmanager_secret" "token_verify_keys" {
  name        = "${var.name}/${var.env}/token-verify-keys"
  description = "camelFS token verification keys: the runtime's public JWKS (Ed25519), injected into the api tasks as CAMELFS_JWKS. Set with infra/camelfs/jwks.sh."

  lifecycle {
    prevent_destroy = true
  }
}
