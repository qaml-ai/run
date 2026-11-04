/** Read-only final inventory. Never terminates resources. */
import { readFileSync, writeFileSync } from "node:fs";
import { Outbound } from "../../src/outbound.ts";
import { microvmApi } from "../../src/computers/microvm.ts";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
const dir = new URL("./", import.meta.url);
const files = ["results.json", "node22-results.json", "rust-results.json", "typescript-results.json", "typescript-go127-results.json"];
const runs = files.map(file => JSON.parse(readFileSync(new URL(file, dir), "utf8")));
const identity = await new STSClient({ region: "us-west-2" }).send(new GetCallerIdentityCommand({}));
if (identity.Account !== "904534089871" || identity.Arn !== "arn:aws:iam::904534089871:user/macbook") throw new Error("Unexpected AWS identity");
const outbound = new Outbound(), api = microvmApi("us-west-2", outbound);
const inventory: any[] = [];
let nextToken: string | undefined;
do {
  const page = await api("ListMicrovms", { maxResults: 50, ...(nextToken ? { nextToken } : {}) });
  inventory.push(...page.items); nextToken = page.nextToken;
} while (nextToken);
const owned: { microvmId: string; state: string; startedAt: number; terminatedAt?: number; imageArn: string; imageVersion: string; maximumDurationInSeconds: number }[] = [];
for (const run of runs) for (const vm of run.created) {
  if (!vm.token.startsWith("camelrun-bench-") || !run.api.some((e: any) => e.op === "RunMicrovm" && e.id === vm.id)) throw new Error("Missing launch evidence");
  const { microvmId, state, startedAt, terminatedAt, imageArn, imageVersion, maximumDurationInSeconds } = await api("GetMicrovm", { microvmIdentifier: vm.id });
  owned.push({ microvmId, state, startedAt, terminatedAt, imageArn, imageVersion, maximumDurationInSeconds });
}
const verified = owned.every(vm => vm.state === "TERMINATED") &&
  inventory.filter(vm => owned.some(own => own.microvmId === vm.microvmId)).every(vm => vm.state === "TERMINATED");
const result = { at: new Date().toISOString(), initialInventory: runs[0].before, inventory, owned, verified,
  activeOwned: inventory.filter(vm => owned.some(own => own.microvmId === vm.microvmId) && vm.state !== "TERMINATED") };
writeFileSync(new URL("cleanup-audit.json", dir), JSON.stringify(result, null, 2) + "\n");
await outbound.dispatcher.close();
console.log(JSON.stringify(result));
if (!verified) throw new Error("Benchmark cleanup is not complete");
