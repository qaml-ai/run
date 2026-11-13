# Secret containers only. Values are set by infra/camelfs/jwks.sh and service-key.sh, never by Terraform, so no key
# material enters Terraform state. Do not add aws_secretsmanager_secret_version resources here.
#
# Runtime → tier tokens (camel-fs.md §1.10) are EdDSA/Ed25519 JWTs (typ camelfs+jwt, aud camelrun:camelfs) signed by the runtime's
# existing signer (backends/workers/src/runtime-identity.ts: private keys sealed in its Postgres signing_keys,
# published at <runtime>/.well-known/jwks.json). The tier only verifies, from a copy of that public JWKS, and
# never calls the network for keys: the secret below holds the JWKS ({"keys":[{kty:"OKP", crv:"Ed25519", x, kid,
# alg:"EdDSA", use:"sig"}, ...]}, two keys during a rollover) and ECS injects it into the api task as the
# environment variable CAMELFS_JWKS (ecs.tf). The api task role cannot read the secret; only the execution role
# can, for the injection. A rotation is `jwks.sh set` then a roll of the service.
#
# Tier → host tokens (camelfs-host+jwt, K4: boot/stop pushed to a host's compute listener) are signed by the
# service's OWN Ed25519 key, separate from the runtime's: the private key lives in service-signing-key (injected
# into the api task as CAMELFS_SERVICE_SIGNING_KEY; the execution role reads it, the task role does not) and its
# public JWKS in service-verify-keys, which the host policy may read (a public key is not secret, but Secrets
# Manager is the one store every host role can already reach without touching the job-hosts module's SSM deny).
# service-key.sh new generates a pair and writes both; the previous public key stays in the JWKS for a rollover.

resource "aws_secretsmanager_secret" "token_verify_keys" {
  name        = "${var.name}/${var.env}/token-verify-keys"
  description = "camelFS token verification keys: the runtime's public JWKS (Ed25519), injected into the api tasks as CAMELFS_JWKS. Set with infra/camelfs/jwks.sh."

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "service_signing_key" {
  name        = "${var.name}/${var.env}/service-signing-key"
  description = "camelFS service signing key (Ed25519 private key, PEM + kid, JSON) for tier → host tokens; injected into the api tasks as CAMELFS_SERVICE_SIGNING_KEY. Set with infra/camelfs/service-key.sh."

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "service_verify_keys" {
  name        = "${var.name}/${var.env}/service-verify-keys"
  description = "camelFS service verification keys: the public JWKS (Ed25519) of service-signing-key, two keys during a rollover; read by the hosts. Set with infra/camelfs/service-key.sh."

  lifecycle {
    prevent_destroy = true
  }
}
