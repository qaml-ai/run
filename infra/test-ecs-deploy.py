"""Exercise the real deploy script with fake AWS/curl; no credentials or network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
ARN = "arn:aws:ecs:us-west-2:000000000000:task-definition/runtime:2"
MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['DEPLOY_TEST_DIR'])
name = pathlib.Path(sys.argv[0]).name
with (root / 'calls').open('a') as f:
    f.write(json.dumps([name, *sys.argv[1:]]) + '\n')
if name in ('sleep', 'curl'):
    sys.exit(0)
args = sys.argv[3:]  # --region value
command = ' '.join(args[:2])
if command == 'ecr describe-images':
    pass
elif command == 'ecs describe-task-definition':
    print(json.dumps({'taskDefinition': {'containerDefinitions': [{'name': 'agent-runtime'}]}}))
elif command == 'ecs register-task-definition':
    print(os.environ['DEPLOY_TEST_ARN'])
elif command == 'ecs update-service':
    pass
elif command == 'elbv2 describe-target-groups':
    print('target-group')
elif command == 'ecs describe-services':
    states = json.loads((root / 'states').read_text())
    state = states.pop(0)
    (root / 'states').write_text(json.dumps(states))
    if state == 'API_ERROR':
        sys.exit(42)
    if state == 'MISSING':
        print('None')
    else:
        primary = os.environ['DEPLOY_TEST_ARN'] if state != 'ROLLBACK' else 'runtime:1'
        print('1\necs-svc/test\t' + primary + '\t' + ('COMPLETED' if state == 'ROLLBACK' else state))
elif command == 'ecs list-tasks':
    print('task-arn')
elif command == 'ecs describe-tasks':
    print('10.0.0.1')
elif command == 'elbv2 describe-target-health':
    print('10.0.0.1')
else:
    sys.exit('Unexpected mocked AWS command: ' + command)
'''


class DeployTest(unittest.TestCase):
    def run_deploy(self, states):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'states').write_text(json.dumps(states))
            for name in ('aws', 'curl', 'sleep'):
                path = root / name
                path.write_text(MOCK)
                path.chmod(0o755)
            result = subprocess.run(
                ['bash', str(ROOT / 'infra/ecs-deploy.sh'), 'test-image'],
                env={**{k: v for k, v in os.environ.items() if k not in ('BASH_ENV', 'ENV')},
                     'PATH': f'{root}:{os.environ["PATH"]}',
                     'DEPLOY_TEST_DIR': directory, 'DEPLOY_TEST_ARN': ARN},
                capture_output=True, text=True, timeout=10,
            )
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            # Rollback/failure must never trigger another update or restore operation.
            updates = [call for call in calls if call[0] == 'aws' and call[3:5] == ['ecs', 'update-service']]
            self.assertEqual(len(updates), 1)
            return result, calls

    def test_waits_for_completion_after_healthy_targets(self):
        result, calls = self.run_deploy(['IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('waiting for deployment completion', result.stdout)
        self.assertIn('rollout COMPLETED)', result.stdout)
        self.assertEqual(sum(call[0] == 'sleep' for call in calls), 1)

    def test_rollback_before_readiness(self):
        result, calls = self.run_deploy(['ROLLBACK'])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('::error::rolled back:', result.stderr)
        self.assertFalse(any(call[0] == 'curl' for call in calls))

    def test_rollback_after_readiness(self):
        result, _ = self.run_deploy(['IN_PROGRESS', 'IN_PROGRESS', 'ROLLBACK'])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('new tasks healthy: 1/1', result.stdout)
        self.assertIn('::error::rolled back:', result.stderr)
        self.assertNotIn('deployed:', result.stdout)

    def test_rollback_during_public_smoke(self):
        result, _ = self.run_deploy(['COMPLETED', 'COMPLETED', 'ROLLBACK'])
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('deployed:', result.stdout)

    def test_failure_missing_state_and_api_error(self):
        for state in ('FAILED', 'MISSING', 'API_ERROR'):
            with self.subTest(state=state):
                result, _ = self.run_deploy(['IN_PROGRESS', state])
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('deployed:', result.stdout)


if __name__ == '__main__':
    unittest.main()
