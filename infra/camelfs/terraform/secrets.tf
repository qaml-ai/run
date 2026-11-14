# Secret containers only. Values are set by infra/camelfs/jwks.sh (and aop.sh for the AOP CA in mtls.tf), never by
# Terraform, so no key material enters Terraform state. Do not add aws_secretsmanager_secret_version resources here.
#
# Runtime → tier tokens (camel-fs.md §1.10) are EdDSA/Ed25519 JWTs (typ camelfs+jwt, aud camelrun:camelfs) signed by
# the runtime's existing signer (backends/workers/src/runtime-identity.ts: private keys sealed in its Postgres
# signing_keys, published at <runtime>/.well-known/jwks.json). The tier only verifies, from a copy of that public
# JWKS, and never calls the network for keys: the secret below holds the JWKS ({"keys":[{kty:"OKP", crv:"Ed25519",
# x, kid, alg:"EdDSA", use:"sig"}, ...]}, two keys during a rollover) and ECS injects it into the api task as the
# environment variable CAMELFS_JWKS (ecs.tf). The api task role cannot read the secret; only the execution role
# can, for the injection. A rotation is `jwks.sh set` then a roll of the service.
#
# Tier ↔ host calls use no token: mutual TLS (§9.12, mtls.tf). The service-signing-key / service-verify-keys
# secrets of the retired camelfs-host+jwt family were deleted with that change.
#
# The notify webhook (§9.11): the tier signs each delivery to <runtime>/v1/internal/camelfs/notify with an HMAC key
# both sides hold (Camel-Signature: t=…,v1=hex hmac-sha256(notifyKey, t + "." + body)). notify-key.sh generates it
# into the secret below and prints the runtime's `wrangler secret put` for the same value; ECS injects it into the
# api task as CAMELFS_NOTIFY_KEY. Separate from every token key, as the design requires.

resource "aws_secretsmanager_secret" "token_verify_keys" {
  name        = "${var.name}/${var.env}/token-verify-keys"
  description = "camelFS token verification keys: the runtime's public JWKS (Ed25519), injected into the api tasks as CAMELFS_JWKS. Set with infra/camelfs/jwks.sh."

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "notify_key" {
  name        = "${var.name}/${var.env}/notify-key"
  description = "camelFS notify webhook HMAC key (§9.11), hex; injected into the api tasks as CAMELFS_NOTIFY_KEY; the runtime holds the same value. Set with infra/camelfs/notify-key.sh."

  lifecycle {
    prevent_destroy = true
  }
}
