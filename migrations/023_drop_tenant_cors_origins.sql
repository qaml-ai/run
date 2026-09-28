-- Browser tokens are read from any origin (their security is the token), so tenants no longer list origins.
drop table if exists tenant_cors_origins;
