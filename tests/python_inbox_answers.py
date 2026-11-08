import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'clients' / 'python'))
from camelai_run import AgentRuntime
from camelai_run.sync import AgentRuntime as SyncRuntime

class InboxAnswers(unittest.TestCase):
    def test_both_clients_share_request_contract(self):
        payload = {'requestId': 'review-1', 'answers': [{'id': 'input', 'version': 3, 'action': 'accept'}]}
        class Capture:
            def _rest(self, method, path, body):
                return method, path, body
        for runtime in (AgentRuntime, SyncRuntime):
            result = runtime.answer_inbox(Capture(), payload['answers'], request_id='review-1')
            self.assertEqual(result, ('POST', '/v1/inbox/answers', payload))

if __name__ == '__main__':
    unittest.main()
