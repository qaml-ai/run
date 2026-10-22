-- GET /v1/agents' lastActiveAt and lastError: when an agent's latest run ended, and when its latest failed run did and
-- how (a short class, never the error's text). Written when a run ends. Nullable, so adding them rewrites nothing.
alter table agents add column last_active_at bigint;
alter table agents add column last_error_at bigint;
alter table agents add column last_error_class text;
