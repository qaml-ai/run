-- Current turn node-loss resumes, mirrored from the durable request journal before model work.
-- Reset only when the run ends or new work begins; backoff survives a resumed start.
alter table agents add column turn_resumes integer not null default 0;
