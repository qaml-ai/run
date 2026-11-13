# Secret containers only. Values are set and rotated by infra/camelfs/token-key.sh, never by Terraform, so no key
# ever enters Terraform state. Do not add aws_secretsmanager_secret_version resources here.
#
# Tokens (camel-fs.md §1.10) are signed by the runtime and verified by the api tier, with two keys valid during a
# rollover. Two secrets, never one value, so that the tier can verify without being able to mint:
#   token-signing-key   the ES256 private key (PKCS#8 PEM) and its kid. Read by the operator, who gives it to the
#                       runtime (a Workers secret); the api role cannot read it.
#   token-verify-keys   the public keys as a JWK set {"keys":[{kid, kty:"EC", crv:"P-256", x, y}, ...]}, newest
#                       first. The api tasks read it at boot (CAMELFS_TOKEN_KEYS_SECRET_ARN) and on a SIGHUP.

resource "aws_secretsmanager_secret" "token_signing_key" {
  name        = "${var.name}/${var.env}/token-signing-key"
  description = "camelFS token signing key (ES256 private key, PEM) + kid, JSON. The runtime signs with it; nothing in AWS reads it. Set with infra/camelfs/token-key.sh."

  lifecycle {
    # Losing it is a forced rotation across the runtime; deleting it by accident must not be a plan away.
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "token_verify_keys" {
  name        = "${var.name}/${var.env}/token-verify-keys"
  description = "camelFS token verification keys (JWK set of ES256 public keys, newest first; two during a rollover). The api tier reads it. Set with infra/camelfs/token-key.sh."

  lifecycle {
    prevent_destroy = true
  }
}
