-- What a channel's filter said about a message: outcome, reason, score and threshold, no content. Null for a channel without one.
alter table channel_seen add column verdict jsonb;
