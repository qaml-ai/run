### Admin tenants' runs have a backstop

A tenant in the tenants file (an admin tenant: chiridion-prod, camel-bots, an operator's own) had no run limit unless its
entry set `maxRunResponses`/`maxRunSeconds`; on 2026-10-27 one scheduled run looped for 25 hours and 71k messages. Their
runs now stop at `AGENT_ADMIN_MAX_RUN_RESPONSES` (default 1000) or `AGENT_ADMIN_MAX_RUN_SECONDS` (default 14400, 4
hours), with `stopped: "turn_limit"`; an entry's own limits still replace them. Seven days of turns: 99.9% end within 25
minutes and ~100 responses, the longest legitimate one 92 minutes and 229.
