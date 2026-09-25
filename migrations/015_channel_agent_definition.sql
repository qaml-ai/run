-- A channel conversation's agent names its channel's definition. Agents made before
-- 006 gave each channel a definition have none in their header, so applying the
-- definition did not reach them. Revision 0 is older than any revision, so the next
-- apply gives them the definition's current one.
update agents a set header = (a.header::jsonb || jsonb_build_object('definition', jsonb_build_object('id', c.channel->>'definition', 'revision', 0)))::json
from channel_conversations cc join channels c on c.id = cc.channel
where cc.agent = a.id and c.tenant = a.tenant and a.header->'definition' is null and c.channel->>'definition' is not null;
