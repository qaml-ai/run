### Console: organized around workspaces

The console's sidebar now has a workspace switcher (shown once an account has a workspace) over the pages it scopes,
and an **Account** group for what is account-wide. The selection is `?ws=` in the URL, so a link keeps it.

- **Overview** is home once an account has an agent: spend against the previous 30 days, running agents, recent
  failures (class and time only) and spend by model and tool. Get started stays home before the first agent.
- **Agents** is paged and filtered on the server (search, Running, Failed · 24h, Sub-agents, Expiring), shows each
  agent's workspace and last activity, and moves agents between workspaces in bulk.
- **Workspaces** shows each workspace's spend and members; each has a settings page (rename, definitions, agents,
  archive).
- **Usage** moved out of Settings: a daily chart stacked by workspace, By workspace / By model / By day (paged)
  tabs, the range in the URL, and CSV export of the current view.
- Old console URLs keep working; `/console/settings` opens Settings → Telemetry.
