"""Run with python3 tests/contract/python_runner_test.py; no third-party packages."""
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

from python_runner import checked_result, inventory, RESULT_MARKER, run_cases


def case(name):
    return {"area": "python", "source": "tests/python_sdk.py", "name": name, "file": "tests/contract/python.py"}


def result(selected, status="pass", code=0):
    return subprocess.CompletedProcess([], code, RESULT_MARKER + json.dumps({**selected, "status": status, "backend": "sdk-unit"}) + "\n", "")


class PythonRunnerTest(unittest.TestCase):
    def test_inventory_is_sorted_and_contains_only_unittest_methods(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "test_source.py"
            source.write_text("""import unittest
class Helpers:
    def test_not_a_case(self): pass
class Zebra(unittest.TestCase):
    def test_second(self): pass
class Alpha(unittest.IsolatedAsyncioTestCase):
    async def test_first(self): pass
    def helper(self): pass
""")
            self.assertEqual([row["name"] for row in inventory(source)], ["Alpha.test_first", "Zebra.test_second"])

    def test_parallel_children_keep_exact_inventory_order(self):
        selected = [case(f"Fixture.test_{i}") for i in range(4)]
        barrier = threading.Barrier(2, timeout=2)
        lock = threading.Lock()
        active = 0
        maximum = 0
        launched = []

        def launch(row):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                launched.append(row["name"])
            barrier.wait()
            with lock:
                active -= 1
            return result(row)

        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = run_cases(selected, "unused.py", 2, launch)
        self.assertEqual(status, 0)
        self.assertEqual(maximum, 2)
        self.assertCountEqual(launched, [row["name"] for row in selected])
        reported = [json.loads(line[len(RESULT_MARKER):])["name"] for line in output.getvalue().splitlines()]
        self.assertEqual(reported, [row["name"] for row in selected])

    def test_invalid_child_results_are_failures_instead_of_missing_or_duplicate_cases(self):
        selected = case("Fixture.test_one")
        good = result(selected)
        invalid = [subprocess.CompletedProcess([], 0, "", ""),
                   subprocess.CompletedProcess([], 0, good.stdout * 2, ""),
                   result(case("Fixture.test_wrong")), result(selected, code=1),
                   result(selected, status="out-of-scope")]
        for child in invalid:
            with self.subTest(child=child):
                stdout, _, code = checked_result(selected, child)
                rows = [json.loads(line[len(RESULT_MARKER):]) for line in stdout.splitlines() if line.startswith(RESULT_MARKER)]
                self.assertEqual(code, 1)
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["name"], selected["name"])
                self.assertEqual(rows[0]["status"], "fail")

    def test_failed_assertion_is_preserved(self):
        selected = case("Fixture.test_failure")
        failed = result(selected, "fail", 1)
        stdout, _, code = checked_result(selected, failed)
        self.assertEqual(code, 1)
        self.assertEqual(stdout, failed.stdout)


if __name__ == "__main__":
    unittest.main()
