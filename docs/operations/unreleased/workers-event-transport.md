### Event transport negotiation in the SDKs

The TypeScript and Python SDKs offer a WebSocket for agent and run event streams as well as SSE (`Accept` names both).
A server that answers with an SSE content type, as this runtime does, selects SSE: nothing changes against it, and no
option is new or required. A server can instead answer with a same-origin WebSocket; the SDK then streams over it, with
the credential in the WebSocket subprotocol, never the URL, and a failed socket reconnects rather than silently falling
back to SSE. `watchAgent` takes `transport: "websocket"` to require one. The Python SDK now depends on `websockets`
(15 to 17). A TypeScript client or watcher given its own `fetch` asks for SSE alone (see "Event streams go through your
own fetch").

Only the experimental Workers backend in `backends/workers/`, an internal pilot and not a supported deployment, offers
WebSockets today. It also serves SSE to clients that ask for it, from its stateless front Worker over the same
hibernatable WebSocket to the agent, with the same ids and `Last-Event-ID` resume as Node; an SSE stream idle for 5
minutes ends with a `reconnect` frame and its client resumes at once.
