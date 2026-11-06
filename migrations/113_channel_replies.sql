-- Where a channel message's turn answers, kept past its item (channel_items rows go once sent): a conversation that
-- spans threads (a Slack channel answered by one agent) sends a later reply of that run, or a notice of a sub-agent
-- the run started, to the same thread. Pruned with the channel's other bookkeeping, and deleted with the channel.
create table channel_replies (
  channel text not null,
  run text not null,
  reply_to text not null,
  created_at timestamptz not null default now(),
  primary key (channel, run)
);
create index channel_replies_created_at on channel_replies (created_at);
