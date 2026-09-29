-- Email channels (src/channels-email.ts). A channel's address is in its settings and
-- unique across all tenants, since mail to it must find exactly one channel.
create unique index channels_email_address on channels ((lower(channel->'settings'->>'address'))) where channel->>'type' = 'email';
-- What a reply to an email conversation needs: the channel, who replies go to (the
-- last allowed sender), the thread's subject, its References (the root and the most
-- recent Message-IDs) and the message replies answer.
create table email_threads (
  conversation text primary key,
  channel text not null,
  reply_to text not null,
  subject text not null,
  refs json not null,
  last_message text not null,
  updated_at bigint not null
);
create index email_threads_channel on email_threads (channel);
-- Every Message-ID in a channel's threads, ours and theirs, so a reply that names
-- only the message it answers still finds its thread.
create table email_messages (
  channel text not null,
  message_id text not null,
  conversation text not null,
  created_at bigint not null,
  primary key (channel, message_id)
);
