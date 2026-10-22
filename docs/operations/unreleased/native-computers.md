### Native computers

Agents can connect to Modal, Daytona, Boat, E2B, Browserbase, or a Docker runner
reached through Cloudflare Tunnel. The Computers page stores provider credentials
encrypted, attaches shell or browser tools automatically, and shows session state
and compute seconds by workspace. Providers bill the connected account directly.

Sessions have fixed expiries and daily time budgets. Durable operation receipts
prevent duplicate mutations after retries. Cleanup is retried; credentials and
references are removed after successful disconnect. Account deletion waits for
provider cleanup. The setup and recovery guide is `docs/guides/computers.md`.
