-- Every agent header names its tenant. Headers written before tenants existed (the
-- old single-tenant mode's "default" tenant) left it out; the row's tenant column
-- always had it. Their ids and token derivations stay as they were: ids are only
-- derived when an agent is created, and no tenant named "default" exists to create
-- one with a pre-tenant idempotency key again.
update agents set header = (header::jsonb || jsonb_build_object('tenant', tenant))::json
where header->>'tenant' is null;
