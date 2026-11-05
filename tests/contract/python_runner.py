"""Dependency-free inventory and isolated per-case scheduling for the Python contract."""
import ast
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys


OUT_OF_SCOPE = {
    ("PythonSDKTest", "test_voice_sessions_need_the_runtime_to_hold_calls"),
    ("PythonSDKTest", "test_audio_is_transcribed_in_messages_runs_and_on_its_own"),
    ("VoiceLibraryTest", "test_get_async_and_sync"),
    ("VoiceLibraryTest", "test_search_async_and_sync"),
}
RESULT_MARKER = "@@CONTRACT_RESULT@@"


def inventory(source):
    """Static discovery is verified against unittest's real discovery in each child."""
    parsed = ast.parse(Path(source).read_text())
    rows = []
    for definition in parsed.body:
        if not isinstance(definition, ast.ClassDef):
            continue
        if not any(isinstance(base, ast.Attribute) and isinstance(base.value, ast.Name)
                   and base.value.id == "unittest" and base.attr in ("TestCase", "IsolatedAsyncioTestCase") for base in definition.bases):
            continue
        for method in definition.body:
            if not isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef)) or not method.name.startswith("test_"):
                continue
            scoped = (definition.name, method.name) in OUT_OF_SCOPE
            rows.append({"area": "python", "source": "tests/python_sdk.py", "name": f"{definition.name}.{method.name}",
                         "file": "tests/contract/python.py", **({"status": "out-of-scope", "reason": "Voice/audio is out of scope"} if scoped else {})})
    return sorted(rows, key=lambda row: row["name"])


def checked_result(case, result):
    """An abnormal child becomes a failed case; it cannot hide a duplicate or a missing result."""
    lines = result.stdout.splitlines()
    reported = []
    try:
        reported = [json.loads(line[len(RESULT_MARKER):]) for line in lines if line.startswith(RESULT_MARKER)]
    except (ValueError, TypeError):
        pass
    reason = None
    if len(reported) != 1 or any(not isinstance(row, dict) or row.get("name") != case["name"] or row.get("area") != "python" or row.get("source") != case["source"] for row in reported):
        reason = "Python subprocess did not report exactly its selected case"
    elif reported[0].get("status") not in ("pass", "fail", "out-of-scope") or (reported[0].get("status") == "out-of-scope" and case.get("status") != "out-of-scope") or (reported[0].get("status") == "pass" and case.get("status") == "out-of-scope"):
        reason = "Python subprocess reported an invalid or unexpected scope status"
    elif result.returncode and reported[0].get("status") != "fail":
        reason = f"Python subprocess exited with {result.returncode} after reporting success"
    if reason:
        # Keep diagnostics, but replace invalid result lines with one explicit
        # failure so the outer inventory check still has an exact accounting.
        lines = [line for line in lines if not line.startswith(RESULT_MARKER)]
        lines.append(RESULT_MARKER + json.dumps({**case, "status": "fail", "backend": "fixture", "reason": reason}))
    failed = reason is not None or result.returncode != 0 or any(row.get("status") == "fail" for row in reported)
    return "\n".join(lines) + "\n", result.stderr, int(failed)


def run_cases(cases, script, concurrency, launch=None):
    if not 1 <= concurrency <= 16:
        raise ValueError("CONTRACT_PYTHON_CONCURRENCY must be from 1 to 16")
    if launch is None:
        launch = lambda case: subprocess.run([sys.executable, str(script), f"--case={case['name']}"], capture_output=True, text=True, env=os.environ.copy())

    def run(case):
        return checked_result(case, launch(case))

    failed = 0
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        # map yields in inventory order, even when processes finish out of order.
        for stdout, stderr, code in executor.map(run, cases):
            print(stdout, end="", flush=True)
            print(stderr, end="", file=sys.stderr, flush=True)
            failed = max(failed, code)
    return failed
