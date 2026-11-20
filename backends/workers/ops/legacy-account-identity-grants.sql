-- Account identity reads need the public login and provider names, never key material.
grant select (tenant, email) on tenant_passwords to :"compatibility_role";
grant select (tenant, provider) on provider_keys to :"compatibility_role";
