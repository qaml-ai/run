-- The runtime's keys for signing identity tokens for tool servers (auth "runtime").
-- The private key is sealed with AGENT_SECRETS_KEY; the public key is published
-- at /.well-known/jwks.json. A retired key stays listed until tokens it signed expire.
create table signing_keys (
  kid text primary key,
  public_jwk jsonb not null,
  private_sealed jsonb not null,
  created_at bigint not null,
  retired_at bigint
);
