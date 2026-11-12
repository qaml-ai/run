// The job-host scaler, a Lambda run every minute (infra/job-hosts/terraform/scaler.tf). It reads the runtime's per-pool
// demand with its own credential (JOB_HOST_SCALER_TOKEN, kept in an SSM SecureString), reads the pools' Auto Scaling
// groups, and does what plan.mjs decides. It logs each action as one JSON line.
import { AutoScalingClient, CompleteLifecycleActionCommand, DescribeAutoScalingGroupsCommand, SetDesiredCapacityCommand, TerminateInstanceInAutoScalingGroupCommand } from "@aws-sdk/client-auto-scaling";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { plan } from "./plan.mjs";

const autoscaling = new AutoScalingClient({});
const ssm = new SSMClient({});
const HOOK = "drain";

export async function handler() {
  const token = (await ssm.send(new GetParameterCommand({ Name: process.env.TOKEN_PARAMETER, WithDecryption: true }))).Parameter?.Value;
  if (!token) throw new Error("No scaler token");
  const runtime = process.env.RUNTIME_URL.replace(/\/+$/, "");
  const call = async (path, method = "GET") => {
    const response = await fetch(`${runtime}${path}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return response.json();
  };
  const demand = await call("/v1/internal/job-hosts/demand");
  const names = { build: process.env.BUILD_ASG, test: process.env.TEST_ASG };
  const slots = { build: Number(process.env.BUILD_SLOTS ?? 1), test: Number(process.env.TEST_SLOTS ?? 8) };
  const wanted = Object.values(names).filter(Boolean);
  const described = wanted.length ? (await autoscaling.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: wanted }))).AutoScalingGroups ?? [] : [];
  const groups = Object.fromEntries(Object.entries(names).map(([pool, name]) => {
    const group = described.find(item => item.AutoScalingGroupName === name);
    return [pool, group && { name, min: group.MinSize, max: group.MaxSize, desired: group.DesiredCapacity, slots: slots[pool],
      instances: (group.Instances ?? []).map(instance => ({ id: instance.InstanceId, state: instance.LifecycleState })) }];
  }));
  const actions = plan(demand, groups, { now: Date.now(), idleMs: Number(process.env.IDLE_MINUTES ?? 10) * 60_000 });
  for (const action of actions) {
    try {
      if (action.type === "drain") await call(`/v1/internal/job-hosts/${encodeURIComponent(action.host)}/drain`, "POST");
      else if (action.type === "undrain") await call(`/v1/internal/job-hosts/${encodeURIComponent(action.host)}/drain`, "DELETE");
      else if (action.type === "desired") await autoscaling.send(new SetDesiredCapacityCommand({ AutoScalingGroupName: action.group, DesiredCapacity: action.desired, HonorCooldown: false }));
      else if (action.type === "terminate") await autoscaling.send(new TerminateInstanceInAutoScalingGroupCommand({ InstanceId: action.instance, ShouldDecrementDesiredCapacity: true }));
      else if (action.type === "complete") await autoscaling.send(new CompleteLifecycleActionCommand({ AutoScalingGroupName: action.group, LifecycleHookName: HOOK, InstanceId: action.instance, LifecycleActionResult: "CONTINUE" }));
      console.log(JSON.stringify({ type: "job_host_scaler_action", ...action }));
    } catch (error) {
      // One action failing does not stop the others; the next minute decides again from what it sees then.
      console.error(JSON.stringify({ type: "job_host_scaler_action_failed", ...action, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
    }
  }
  return { actions: actions.length };
}
