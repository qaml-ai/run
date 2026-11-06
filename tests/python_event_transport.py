"""Wire-level negotiation checks without a model, AWS or Cloudflare account."""
import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "clients", "python"))
import httpx
from websockets.asyncio.server import serve
from camelai_run.event_transport import event_stream, event_stream_sync, _frame, _selection, _SocketResponse


class EventTransport(unittest.IsolatedAsyncioTestCase):
    async def test_node_sse_response_is_selected_once(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text="event: ready\ndata: {}\n\n")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            async with event_stream(client, "https://runtime.test/events", headers={"Authorization": "Bearer fixture"}) as response:
                self.assertEqual(b"".join([part async for part in response.aiter_bytes()]), b"event: ready\ndata: {}\n\n")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].headers["accept"], "application/vnd.camelrun.events+json, text/event-stream")

    async def test_websocket_frames_and_authentication(self):
        seen = []
        async def handler(socket):
            seen.append(socket.request.headers["Sec-WebSocket-Protocol"])
            await socket.send(json.dumps({"event": "ready", "data": {}}))
            await socket.send(json.dumps({"id": 9, "data": {"type": "snapshot", "turn": None}}))
            await socket.close()
        async with serve(handler, "127.0.0.1", 0, subprotocols=["camelrun.events.v1"]) as server:
            port = server.sockets[0].getsockname()[1]
            url = f"http://127.0.0.1:{port}/events"
            def handle(request):
                return httpx.Response(200, headers={"content-type": "application/vnd.camelrun.events+json"}, json={"transport": "websocket", "protocol": "camelrun.events.v1", "url": "/events"})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                async with event_stream(client, url, headers={"Authorization": "Bearer fixture"}) as response:
                    frames = [part async for part in response.aiter_bytes()]
            self.assertEqual(frames, [b"event: ready\ndata: {}\n\n", b'id: 9\ndata: {"type":"snapshot","turn":null}\n\n'])
            self.assertIn("bearer.Zml4dHVyZQ", seen[0])

    async def test_synchronous_websocket_frames(self):
        async def handler(socket):
            await socket.send(json.dumps({"event": "ready", "data": {}}))
            await socket.close()
        async with serve(handler, "127.0.0.1", 0, subprotocols=["camelrun.events.v1"]) as server:
            port = server.sockets[0].getsockname()[1]
            def run():
                def handle(request):
                    return httpx.Response(200, headers={"content-type": "application/vnd.camelrun.events+json"}, json={"transport": "websocket", "protocol": "camelrun.events.v1", "url": "/events"})
                with httpx.Client(transport=httpx.MockTransport(handle)) as client:
                    with event_stream_sync(client, f"http://127.0.0.1:{port}/events", headers={"Authorization": "Bearer fixture"}) as response:
                        return list(response.iter_bytes())
            self.assertEqual(await asyncio.to_thread(run), [b"event: ready\ndata: {}\n\n"])

    async def test_closed_control_ends_async_stream_before_native_close(self):
        async def handler(socket):
            await socket.send(json.dumps({"event": "closed", "data": {"reason": "expired"}}))
            # The server waits for the client; it sends no native close frame.
            await socket.wait_closed()
        async with serve(handler, "127.0.0.1", 0, subprotocols=["camelrun.events.v1"]) as server:
            port = server.sockets[0].getsockname()[1]
            def handle(request):
                return httpx.Response(200, headers={"content-type": "application/vnd.camelrun.events+json"}, json={"transport": "websocket", "protocol": "camelrun.events.v1", "url": "/events"})
            async def read():
                async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                    async with event_stream(client, f"http://127.0.0.1:{port}/events", headers={"Authorization": "Bearer fixture"}) as response:
                        return [part async for part in response.aiter_bytes()]
            self.assertEqual(await asyncio.wait_for(read(), 2), [b'event: closed\ndata: {"reason":"expired"}\n\n'])

    async def test_closed_control_ends_sync_stream_without_another_socket_read(self):
        def socket_frames():
            yield json.dumps({"event": "closed", "data": {"reason": "expired"}})
            raise AssertionError("Read another socket frame after the closed control")
        self.assertEqual(list(_SocketResponse(socket_frames()).iter_bytes()), [b'event: closed\ndata: {"reason":"expired"}\n\n'])

    async def test_invalid_frames_and_cross_origin_are_rejected(self):
        with self.assertRaises(ValueError):
            _frame('{"id":true,"data":{}}')
        with self.assertRaises(ValueError):
            _selection({"transport": "websocket", "protocol": "camelrun.events.v1", "url": "https://evil.test/events"}, "https://runtime.test/events", {"Authorization": "Bearer fixture"})


if __name__ == "__main__":
    unittest.main()
