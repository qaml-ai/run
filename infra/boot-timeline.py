#!/usr/bin/env python3
"""Read-only ECS/CloudWatch startup timeline. No task execution, secret values, or database access.

ECS startedAt is a control-plane observation, not the exact container start. Target health is a current
snapshot; AWS does not expose historical per-target healthy transition timestamps through these APIs.
"""
import argparse
from datetime import datetime, timezone
import json
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--name", default="camelai-agent-runtime")
    args = parser.parse_args()

    def aws(*command):
        return json.loads(subprocess.check_output(["aws", "--region", args.region, *command, "--output", "json"], text=True))

    service = aws("ecs", "describe-services", "--cluster", args.name, "--services", args.name,
                  "--query", "services[0].{deployments:deployments,events:events}")
    arns = aws("ecs", "list-tasks", "--cluster", args.name, "--query", "taskArns")
    if not arns:
        raise SystemExit("No running tasks")
    tasks = aws("ecs", "describe-tasks", "--cluster", args.name, "--tasks", *arns, "--query",
                "tasks[].{arn:taskArn,created:createdAt,pullStart:pullStartedAt,pullEnd:pullStoppedAt,ecsStarted:startedAt,image:containers[0].image}")
    for task in tasks:
        task_id = task["arn"].rsplit("/", 1)[-1]
        events = aws("logs", "filter-log-events", "--log-group-name", f"/ecs/{args.name}",
                     "--log-stream-names", f"runtime/agent-runtime/{task_id}",
                     "--start-time", str(int(task["created"] * 1000)),
                     "--end-time", str(int((task["created"] + 180) * 1000)),
                     "--filter-pattern", '{ $.type = "listening" || $.type = "startup_stage" || $.type = "migration_lock_timeout" }',
                     "--query", "events[].{timestamp:timestamp,message:message}")
        task["startup"] = []
        for event in events:
            message = json.loads(event["message"])
            task["startup"].append({"timestamp": event["timestamp"], **{key: message[key] for key in ["type", "stage", "ms", "uptimeMs"] if key in message}})
        task["seconds"] = {key: round(task[key] - task["created"], 3) for key in ["pullStart", "pullEnd", "ecsStarted"] if task[key] is not None}
        listening = next((entry for entry in task["startup"] if entry["type"] == "listening"), None)
        if listening:
            task["seconds"]["listening"] = round(listening["timestamp"] / 1000 - task["created"], 3)
    target_group = aws("elbv2", "describe-target-groups", "--names", args.name, "--query", "TargetGroups[0].TargetGroupArn")
    health = aws("elbv2", "describe-target-health", "--target-group-arn", target_group, "--query",
                 "TargetHealthDescriptions[].{target:Target.Id,state:TargetHealth.State}")
    print(json.dumps({"observedAt": datetime.now(timezone.utc).isoformat(), "tasks": tasks, "service": service,
                      "targetHealthNow": health, "note": "ecsStarted is not exact container start; health is current, not historical"}, indent=2))


if __name__ == "__main__":
    main()
