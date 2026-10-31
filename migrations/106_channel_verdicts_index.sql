-- migrate: concurrently
-- A channel's filter activity, newest first. Built concurrently: channel_seen takes every channel message's write.
create index concurrently if not exists channel_seen_verdicts on channel_seen (channel, seen_at desc, message desc) where verdict is not null;
