### Event transport negotiation in the SDKs

The TypeScript and Python SDKs offer a WebSocket for agent and run event streams as well as SSE (`Accept` names both).
A server that answers with an SSE content type, as this runtime does, selects SSE: nothing changes against it, and no
option is new or required. A server can instead answer with a same-origin WebSocket; the SDK then streams over it, with
the credential in the WebSocket subprotocol, never the URL, and a failed socket reconnects rather than silently falling
back to SSE. `watchAgent` takes `transport: "websocket"` to require one. The Python SDK now depends on `websockets`
(15 to 17).

Only the experimental Workers backend in `backends/workers/`, an internal pilot and not a supported deployment, offers
WebSockets today.
