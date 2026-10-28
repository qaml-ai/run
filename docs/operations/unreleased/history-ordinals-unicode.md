### History ordinal fill: records Postgres will not parse

`POST /v1/operations/history-ordinals` no longer fails an agent whose entries hold a `\u0000` or a lone surrogate escape
(Postgres refuses them as `jsonb`; about 1% of agents in the first dry run): such a page of entries is read and shaped
on the node, one record at a time, and the agent is placed as its commits would have placed it. Rerun the fill after
this deploys: agents placed already come back `current`.
