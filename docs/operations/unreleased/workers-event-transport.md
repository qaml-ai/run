### Event transport negotiation

The TypeScript and Python SDKs negotiate the agent event transport. A server can offer a WebSocket; a server that answers with an SSE content type explicitly selects SSE. The current Node runtime continues to use SSE. WebSocket failures reconnect without silently downgrading to another transport.

The experimental backend in `backends/workers/` offers hibernatable WebSockets. Browser-token watchers retain their filtered SSE stream. Credentials are carried in the WebSocket subprotocol, never its URL. This does not deploy or enable the Workers backend in production.
