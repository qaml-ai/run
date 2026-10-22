### X search for agents

Agents and stateless runs can enable the `x_search` builtin to search X posts
with Grok, regardless of their main model. Enable it on a definition or directly
on an agent, and add an xAI provider key under Models & keys. The platform's key
is used when available and allowed for the account.

Queries support included or excluded handles and a UTC date range. Results
contain a summary, citations, a truncation indicator and usage counts. Calls are
bounded to two model turns, 1,800 output tokens and a two-minute deadline.

The provider's reported total cost, including model tokens and posts or profiles
fetched, is recorded under `xai/x_search`. Platform-key calls charge prepaid
credit at that cost. The existing web-tools ledger amount includes X searches;
there is no additional flat search fee.

Implementation: `src/x-search.ts`. Test endpoint override:
`AGENT_XAI_RESPONSES_URL` (default `https://api.x.ai/v1/responses`).
