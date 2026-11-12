-- A trigger whose agent was purged is kept but disabled (expand only: a nullable column, no default, no rewrite). Its hook
-- URL then answers 202 without dispatching, so senders that retry any non-2xx (Stripe, for days) stop. Nodes from before
-- this column ignore it: they accept such a hook and record it, and its delivery fails once (the agent answers 404),
-- with no error logged, as before; newer nodes drop deliveries those nodes queued without sending them.
alter table agent_triggers add column disabled_at bigint;
