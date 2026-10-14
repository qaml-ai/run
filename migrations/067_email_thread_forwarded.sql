-- Whether an email thread's last message came through a trusted forwarder (src/channels-email.ts):
-- its sender is then whatever the message's From says, and is not replied to unless the channel opts in.
alter table email_threads add column forwarded boolean not null default false;
