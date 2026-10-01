-- Limits the platform operator set for a self-serve tenant (PUT /v1/tenants/{id}/limits), in place of its plan's;
-- an admin tenant's come from its tenants-file entry. Keys: maxStorageBytes.
alter table tenants add column limits jsonb not null default '{}';
