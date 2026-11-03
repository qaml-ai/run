import importlib.util
from pathlib import Path
import time
import unittest

spec = importlib.util.spec_from_file_location("agent", Path(__file__).with_name("agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def setUp(self):
        agent.JOBS.clear()

    def result(self, job):
        self.assertTrue(job.done.wait(5))
        return job.result

    def test_idempotency_and_conflict(self):
        job = agent.start_job("once", "sleep 0.1; printf done", 2)
        self.assertIs(job, agent.start_job("once", "sleep 0.1; printf done", 2))
        self.assertEqual(self.result(job)["stdout"], "done")
        self.assertIs(job, agent.start_job("once", "sleep 0.1; printf done", 2))
        with self.assertRaises(ValueError):
            agent.start_job("once", "different", 2)

    def test_timeout_and_background_cleanup(self):
        start = time.monotonic()
        result = self.result(agent.start_job("timeout", "sleep 30 & wait", 1))
        self.assertEqual(result["exitCode"], 124)
        self.assertLess(time.monotonic() - start, 3)
        self.assertEqual(self.result(agent.start_job("background", "sleep 30 & echo finished", 2))["stdout"], "finished\n")

    def test_truncation_and_exit_code(self):
        command = "python3 -c 'import sys; print(\"a\"*1000000); print(\"b\"*1000000,file=sys.stderr)'; exit 7"
        result = self.result(agent.start_job("large", command, 3))
        self.assertEqual(result["exitCode"], 7)
        self.assertEqual(len(result["stdout"]), agent.LIMIT)
        self.assertEqual(len(result["stderr"]), agent.LIMIT)
        self.assertTrue(result["truncated"])

    def test_key_budget_never_evicts_a_retry(self):
        old = agent.MAX_JOBS
        try:
            agent.MAX_JOBS = 1
            job = agent.start_job("first", "true", 1)
            self.result(job)
            with self.assertRaises(OverflowError):
                agent.start_job("second", "true", 1)
            self.assertIs(job, agent.start_job("first", "true", 1))
        finally:
            agent.MAX_JOBS = old


if __name__ == "__main__":
    unittest.main()
