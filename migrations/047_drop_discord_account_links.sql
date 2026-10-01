-- Adding Camel to Discord is one authorization (src/discord-managed.ts), so no Discord user token is kept.
-- Nodes from before that change cleaned this table every 10 s; it is dropped once none of them run.
drop table if exists discord_account_links;
