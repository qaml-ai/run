# Signups by source in Ops

The Growth tab stacks daily signups by their first recorded source. The Sources table compares
outside self-serve signups with accounts that made an agent, ran a model, worked on two or more
UTC days, and purchased credit. It also shows each source's share and the median UTC-day wait
to a first model answer. Usage includes scheduled and channel runs and is counted through today.
The range control selects 7, 30 or 90 signup days; 30 is the default.

Counts come from the runtime's accounts and usage records. First-touch sources, campaigns and
landing pages come from the journey store, joined by account reference. Arrivals on the sales site
are grouped by hostname and first landing path, including individual blog posts. The sales-site report
adds `landing_host` from its stored first touch; reports without it retain the original referral label.
Other lists each smaller page or source for the hovered day, largest first. A first OAuth grant
within an hour of signup labels plugin acquisition even without a journey record. Staff and
erased accounts are excluded. Missing sources stay in `Not captured`, including during report
outages or incomplete pagination; they are never counted as direct traffic. Old sources cannot
be reconstructed when they were never recorded.

Browser attribution uses the existing journey configuration: `AGENT_JOURNEY_URL`, the event
signing secret, the separate `AGENT_JOURNEY_REPORT_SECRET`, and the visitor and consent cookies.
Collection continues to respect the configured consent policy. Returning browsers now record
valid campaign tags even when the incoming link has no referrer. The journey store retains
first-touch attribution; a later tagged visit does not replace it.
