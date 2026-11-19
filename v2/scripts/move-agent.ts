import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fenceV1Agent, publishV2AgentRoute, unfenceV1Agent } from "../../src/agent-v2-cutover.ts";
import { databaseFromEnvironment, type Db } from "../../src/db.ts";
import { CamelRun } from "../sdk/src/index.ts";
import { stageAgent } from "./stage-agent.ts";

type Source = Parameters<typeof stageAgent>[0] & { tenant: string; operation: string };
type StageOptions = NonNullable<Parameters<typeof stageAgent>[3]>;

/** The operator has provisioned and checked the v2 configuration and gated independent edits.
 * Rerun deferred agents once the v1 admission fence confirms all accepted work has settled. */
export async function moveAgent(db: Db, source: Source, v2: CamelRun, destination: { tenant: string; agent: string }, options: StageOptions = {}) {
  const key = { tenant: source.tenant, agent: source.agentId, operation: source.operation };
  const existing = (await db.query<{ destination_tenant: string; destination_agent: string }>(
    "select destination_tenant, destination_agent from agent_v2_routes where tenant = $1 and agent = $2", [key.tenant, key.agent],
  )).rows[0];
  if (existing) {
    if (existing.destination_tenant !== destination.tenant || existing.destination_agent !== destination.agent) {
      throw new Error("The v1 agent already has a different v2 destination");
    }
    return { state: "published", source: key.agent, destination: destination.agent } as const;
  }
  if (!await fenceV1Agent(db, key.tenant, key.agent, key.operation)) {
    return { state: "deferred", source: key.agent, destination: destination.agent } as const;
  }

  let receipt;
  try {
    receipt = await stageAgent(source, v2, destination.agent, options);
    if (receipt.destination !== destination.agent) throw new Error("Specify the destination's canonical v2 agent ID");
  } catch (error) {
    try {
      if (!await unfenceV1Agent(db, key.tenant, key.agent, key.operation)) {
        throw new Error("The fence changed or its destination has published");
      }
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "Final copy failed and the v1 fence could not be released");
    }
    throw error;
  }
  // After an uncertain commit, retry with this operation to read the authoritative route.
  if (!await publishV2AgentRoute(db, key, destination)) throw new Error("The verified v2 destination could not be published");
  return { state: "published", ...receipt } as const;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "initial-commit": { type: "string" }, previous: { type: "string" } },
  });
  const [tenant, agentId, operation, destination, ...extra] = positionals;
  if (!tenant || !agentId || !destination || !operation || extra.length ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation)) {
    throw new Error("Usage: move-agent.ts <v1-tenant> <v1-agent> <operation-uuid> <v2-agent-id> [--initial-commit sha] [--previous receipt]");
  }
  const apiKey = env("V2_API_KEY");
  const tenantMatch = /^cr_live_([^./]+)\.[^./]+$/.exec(apiKey);
  if (!tenantMatch) throw new Error("V2_API_KEY must be a destination tenant key");
  const source = { tenant, agentId, operation, url: env("V1_URL"), apiKey: env("V1_API_KEY") };
  const v2 = new CamelRun({ baseUrl: env("V2_URL"), apiKey });
  const db = await databaseFromEnvironment();
  try {
    console.log(JSON.stringify(await moveAgent(db, source, v2, { tenant: tenantMatch[1], agent: destination },
      { initialCommit: values["initial-commit"], previous: values.previous })));
  } finally {
    await Promise.all([v2.close(), db.end()]);
  }
}
