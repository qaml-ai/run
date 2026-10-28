### Signups by source in Ops, kept on each account

The Growth tab stacks daily signups by source. The Sources table compares outside self-serve signups
with accounts that made an agent, ran a model, worked on two or more UTC days, and purchased credit.
It also shows each source's share and the median UTC-day wait to a first model answer. Usage includes
scheduled and channel runs and is counted through today. The range control selects 7, 30 or 90 signup
days; 30 is the default.

Every figure comes from the runtime's own tables in one read; nothing is asked of the journey store,
so the panel answers as fast as the rest of Growth. (Asking the store page by page took 20 seconds
for 414 signups and still left most of them unread.)

A sign-up's source is kept on the account when it is made (`tenants.signup_source`, migration 091),
as camelBot keeps `users.signup_ref`:

- The console sends the `ref` of the link that opened it (`/console/?ref=run-slack`) and the host of
  the site the browser came from when a GitHub or Google sign-in starts, or with an email sign-up.
  They wait in a 10-minute cookie of the sign-in's own (`ar_source`, path `/console/auth`) or with the
  mailed link, and are kept once, on the account the sign-in makes. Signing in again never changes it.
- A browser that sends Global Privacy Control, or whose consent cookie says `denied`, keeps its link's
  tag but not its referrer.
- The sales site tags its links to the console with the page they are on (`ref=home`,
  `ref=run-slack`, `ref=blog/<post>`).

The dashboard's label is, in order: the MCP plugin whose first OAuth grant came within an hour of
signup; `ref=<tag>`; the referring host; Direct (neither shown); Not captured (accounts made before
this release, or by an operator). Missing sources are never counted as direct. The account export's
`account.json` includes `signupSource`.

The journey store's first-touch attribution, campaigns and landing pages are no longer part of this
panel; the Journeys tab still shows them per account.
