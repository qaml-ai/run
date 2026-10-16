import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("collection_task", Path(__file__).with_name("journey-collection-task.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CollectionTaskTest(unittest.TestCase):
    def fixture(self):
        return {"taskDefinition": {
            "taskDefinitionArn": "arn:old", "revision": 42, "status": "ACTIVE",
            "family": "camelai-agent-runtime", "taskRoleArn": "arn:task-role",
            "containerDefinitions": [{"name": "agent-runtime", "image": "registry/runtime:existing",
                "environment": [{"name": "UNRELATED_SETTING", "value": "keep"},
                                {"name": "AGENT_JOURNEY_COLLECT_UNKNOWN", "value": "false"}],
                "secrets": [{"name": "EXISTING_SECRET", "valueFrom": "arn:secret"}]}]},
            "tags": [{"key": "owner", "value": "runtime"}]}

    def test_only_collection_changes_and_live_image_secrets_roles_are_preserved(self):
        original = self.fixture()
        task = module.task_input(original, "true")
        expected = self.fixture()["taskDefinition"]
        for key in ("taskDefinitionArn", "revision", "status"):
            expected.pop(key)
        expected["containerDefinitions"][0]["environment"][1]["value"] = "true"
        expected["tags"] = original["tags"]
        self.assertEqual(task, expected)
        self.assertEqual(original, self.fixture())

    def test_reversible_and_adds_missing_setting_without_duplicates(self):
        described = self.fixture()
        described["taskDefinition"]["containerDefinitions"][0]["environment"] = []
        for value in ("true", "false"):
            task = module.task_input(described, value)
            self.assertEqual(task["containerDefinitions"][0]["environment"],
                             [{"name": "AGENT_JOURNEY_COLLECT_UNKNOWN", "value": value}])

    def test_invalid_value_or_wrong_container_fails_before_registration(self):
        with self.assertRaises(ValueError):
            module.task_input(self.fixture(), "yes")
        described = self.fixture()
        described["taskDefinition"]["containerDefinitions"][0]["name"] = "other"
        with self.assertRaises(ValueError):
            module.task_input(described, "true")


if __name__ == "__main__":
    unittest.main()

