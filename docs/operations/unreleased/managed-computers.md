### Managed computers

An agent can have a Linux computer with no provider account of your own: choose **Managed (no key needed)** under
Computers, or `POST /v1/computers` with `provider: "boat"` and no credentials. It is a small machine for work in the
foreground, charged to credit at what it costs while it runs, and an account starts one once it has bought credit.
`AGENT_MANAGED_COMPUTERS` turns them on, off by default, with `platformKeys.boat` in the tenants file. See
`docs/guides/computers.md`.
