"""Live event transport negotiation. A failed WebSocket is never retried as SSE."""
import base64
from contextlib import asynccontextmanager, contextmanager
import json
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode

import httpx
from websockets.exceptions import WebSocketException

_PROTOCOL = "camelrun.events.v1"
_CAPABILITY = "application/vnd.camelrun.events+json"
_MAX_FRAME = 1_100_000


def _selection(value, url, headers):
    if not isinstance(value, dict) or value.get("transport") != "websocket" or value.get("protocol") != _PROTOCOL or not isinstance(value.get("url"), str):
        raise ValueError("Invalid event transport selection")
    origin, target = urlsplit(url), urlsplit(urljoin(url, value["url"]))
    if (target.scheme, target.netloc) != (origin.scheme, origin.netloc) or target.username or target.password or target.fragment:
        raise ValueError("Invalid event WebSocket origin")
    headers = httpx.Headers(headers)
    authorization = headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        raise ValueError("Event WebSocket requires a bearer token")
    credential = base64.urlsafe_b64encode(authorization[7:].encode("ascii")).decode().rstrip("=")
    query = dict(parse_qsl(target.query))
    for source, destination in (("last-event-id", "cursor"), ("x-agent-connection", "connection")):
        if headers.get(source):
            query[destination] = headers[source]
    endpoint = urlunsplit(("wss" if target.scheme == "https" else "ws", target.netloc, target.path, urlencode(query), ""))
    return endpoint, [_PROTOCOL, "bearer." + credential]


def _frame(message):
    if not isinstance(message, str) or len(message.encode()) > _MAX_FRAME:
        raise ValueError("Invalid event WebSocket frame")
    value = json.loads(message)
    if not isinstance(value, dict) or "data" not in value:
        raise ValueError("Invalid event WebSocket frame")
    event, cursor = value.get("event"), value.get("id")
    if event is not None and event not in ("ready", "reconnect", "closed"):
        raise ValueError("Invalid event WebSocket type")
    if cursor is not None and (type(cursor) is not int or cursor <= 0):
        raise ValueError("Invalid event WebSocket cursor")
    return ((f"event: {event}\n" if event else "") + (f"id: {cursor}\n" if cursor else "") + "data: " + json.dumps(value["data"], separators=(",", ":")) + "\n\n").encode()


class _SocketResponse:
    status_code = 200
    is_success = True
    headers = {"content-type": "text/event-stream", "x-agent-transport": "websocket"}

    def __init__(self, socket):
        self.socket = socket

    async def aiter_bytes(self):
        try:
            async for message in self.socket:
                yield _frame(message)
        except (OSError, WebSocketException) as error:
            raise httpx.ReadError("Event WebSocket failed") from error

    async def aiter_text(self):
        async for message in self.aiter_bytes():
            yield message.decode()

    def iter_bytes(self):
        try:
            for message in self.socket:
                yield _frame(message)
        except (OSError, WebSocketException) as error:
            raise httpx.ReadError("Event WebSocket failed") from error

    def iter_text(self):
        for message in self.iter_bytes():
            yield message.decode()


@asynccontextmanager
async def event_stream(client, url, *, headers, timeout=20):
    """The existing SSE Content-Type explicitly selects SSE, including on Node."""
    from websockets.asyncio.client import connect
    headers = {**headers, "Accept": _CAPABILITY + ", text/event-stream"}
    async with client.stream("GET", url, headers=headers, timeout=timeout) as response:
        if not response.is_success or not response.headers.get("content-type", "").startswith(_CAPABILITY):
            yield response
            return
        endpoint, protocols = _selection(json.loads(await response.aread()), url, headers)
    try:
        async with connect(endpoint, subprotocols=protocols, max_size=_MAX_FRAME, max_queue=64,
                           ping_interval=20, ping_timeout=20, open_timeout=10, close_timeout=2, compression=None) as socket:
            if socket.subprotocol != _PROTOCOL:
                raise ValueError("Event WebSocket protocol was not selected")
            yield _SocketResponse(socket)
    except (OSError, WebSocketException) as error:
        raise httpx.ConnectError("Event WebSocket connection failed") from error


@contextmanager
def event_stream_sync(client, url, *, headers, timeout=20):
    from websockets.sync.client import connect
    headers = {**headers, "Accept": _CAPABILITY + ", text/event-stream"}
    with client.stream("GET", url, headers=headers, timeout=timeout) as response:
        if not response.is_success or not response.headers.get("content-type", "").startswith(_CAPABILITY):
            yield response
            return
        endpoint, protocols = _selection(json.loads(response.read()), url, headers)
    try:
        with connect(endpoint, subprotocols=protocols, max_size=_MAX_FRAME, max_queue=64,
                     ping_interval=20, ping_timeout=20, open_timeout=10, close_timeout=2, compression=None) as socket:
            if socket.subprotocol != _PROTOCOL:
                raise ValueError("Event WebSocket protocol was not selected")
            yield _SocketResponse(socket)
    except (OSError, WebSocketException) as error:
        raise httpx.ConnectError("Event WebSocket connection failed") from error
