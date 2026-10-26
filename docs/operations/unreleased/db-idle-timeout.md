### Database connections stay open a minute when idle

The control-plane pool now keeps an idle connection for 60 s (`AGENT_DATABASE_IDLE_TIMEOUT_MS`; it was pg's 10 s), so a node reconnects, with a TLS handshake, far less often.
