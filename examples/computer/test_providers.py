"""Provider boundary checks without cloud credentials."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python"))
from browser import BrowserTools
from providers import E2BComputer, TunnelComputer
from test_tools import context
from tunnel_server import handler, ThreadingHTTPServer, Session


class ProviderTest(unittest.TestCase):
    def test_byoc_docker_boundary_and_single_claim(self):
        with patch('tunnel_server.subprocess.run') as run:
            session = Session(60)
            command = run.call_args.args[0]
            self.assertIn('--cap-drop', command)
            self.assertIn('no-new-privileges', command)
            self.assertNotIn('--privileged', command)
            self.assertNotIn('--volume', command)
            self.assertNotIn('--network', command)
            session.request('/claim', {'claim': 'a' * 32})
            with self.assertRaises(PermissionError):
                session.request('/claim', {'claim': 'b' * 32})
            with self.assertRaises(PermissionError):
                session.request('/exec', {'claim': 'b' * 32})
            with self.assertRaises(ValueError):
                session.request('/exec', {'claim': 'a' * 32, 'key': 'k' * 32, 'command': 'true', 'timeout': 0})
            session.deadline = time.monotonic() - 1
            with self.assertRaises(TimeoutError):
                session.request('/exec', {'claim': 'a' * 32})
            session.close()
            session.close()
            self.assertEqual(run.call_count, 2)

    def test_e2b_nonzero_exit_is_a_result(self):
        class ExitError(Exception):
            exit_code, stdout, stderr = 7, 'out', 'err'
        sandbox = SimpleNamespace(commands=SimpleNamespace(run=lambda *a, **k: (_ for _ in ()).throw(ExitError())))
        with patch.dict(sys.modules, e2b=SimpleNamespace(CommandExitException=ExitError)):
            computer = E2BComputer.__new__(E2BComputer)
            computer.sandbox = sandbox
            result = computer.execute('false', 10)
            self.assertEqual((result.exit_code, result.stdout, result.stderr), (7, 'out', 'err'))

    def test_tunnel_does_not_send_credentials_over_remote_http(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'connection.json'
            path.write_text(json.dumps({'url':'http://public.example', 'token':'test'}))
            with patch.dict('os.environ', CAMELRUN_COMPUTER_CONNECTION=str(path)):
                with self.assertRaisesRegex(ValueError, 'HTTPS'):
                    TunnelComputer(900)

    def test_server_requires_auth_before_dispatch(self):
        calls = []
        session = SimpleNamespace(request=lambda *args: calls.append(args))
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler(session, 'secret'))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/exec', data=b'{}')
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 401)
            self.assertEqual(calls, [])
        finally:
            server.shutdown()
            server.server_close()


class BrowserTest(unittest.IsolatedAsyncioTestCase):
    async def test_browser_ownership_and_retry(self):
        class Page:
            calls = 0
            async def evaluate(self, expression):
                self.calls += 1
                return {'counter': self.calls}
        page = Page()
        tools = BrowserTools(SimpleNamespace(page=page, expires_at=time.monotonic()+60))
        tools.bind('agent-a')
        with self.assertRaises(PermissionError):
            await tools.call('evaluate', '1', context('agent-b'))
        a = await tools.call('evaluate', '1', context())
        b = await tools.call('evaluate', '1', context())
        self.assertEqual(a, b)
        self.assertEqual(page.calls, 1)
        with self.assertRaises(ValueError):
            await tools.call('evaluate', '2', context())

    async def test_browser_refuses_file_navigation(self):
        tools = BrowserTools(SimpleNamespace(page=object(), expires_at=time.monotonic()+60))
        tools.bind('agent-a')
        with self.assertRaises(RuntimeError):
            await tools.call('navigate', 'file:///etc/passwd', context())


if __name__ == '__main__':
    unittest.main()
