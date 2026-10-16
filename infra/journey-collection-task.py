#!/usr/bin/env python3
"""Clone an ECS task definition, changing only unanswered-visit collection."""
import copy
import json
import sys


def task_input(described, collect_unknown):
    if collect_unknown not in ("true", "false"):
        raise ValueError("collect_unknown must be true or false")
    task = copy.deepcopy(described["taskDefinition"])
    for field in ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
                  "registeredAt", "registeredBy", "deregisteredAt"):
        task.pop(field, None)
    matches = [container for container in task["containerDefinitions"] if container["name"] == "agent-runtime"]
    if len(matches) != 1:
        raise ValueError("expected exactly one agent-runtime container")
    container = matches[0]
    environment = [item for item in container.get("environment", [])
                   if item["name"] != "AGENT_JOURNEY_COLLECT_UNKNOWN"]
    environment.append({"name": "AGENT_JOURNEY_COLLECT_UNKNOWN", "value": collect_unknown})
    container["environment"] = environment
    if described.get("tags"):
        task["tags"] = copy.deepcopy(described["tags"])
    return task


if __name__ == "__main__":
    json.dump(task_input(json.load(sys.stdin), sys.argv[1]), sys.stdout)

