-- Keep existing Boat machines on Boat when the runtime's default changes.
alter table managed_computers add column provider text not null default 'boat';
-- Immutable launch parameters and cumulative observations survive runtime restarts.
alter table managed_computers add column microvm jsonb;
