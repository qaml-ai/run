-- Channels no longer carry an inline `template`. Migration 006 made each channel's
-- template a definition of its own and kept the template only for nodes of the
-- release before it; every release since writes a definition on every channel. A
-- channel still without one (made by an old node after 006 ran) would lose its
-- agents' configuration here, so the migration stops instead: give it a definition
-- (as 006 does) and deploy again.
do $$
declare
  missing text;
begin
  select string_agg(id, ', ' order by id) into missing from channels where channel->>'definition' is null;
  if missing is not null then
    raise exception 'Channels without a definition: %. Give each one before stripping templates.', missing;
  end if;
end $$;
update channels set channel = (channel::jsonb - 'template')::json where channel::jsonb ? 'template';
