import { fenceV1Agent, unfenceV1Agent } from "../../src/agent-v2-cutover.ts";
import { databaseFromEnvironment } from "../../src/db.ts";

const [action, tenant, agent, operation, ...extra] = process.argv.slice(2);
if ((action !== "fence" && action !== "unfence") || !tenant || !agent ||
    !operation || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation) || extra.length) {
  throw new Error("Usage: agent-v2-cutover.ts <fence|unfence> <tenant> <agent> <operation-uuid>");
}

const db = await databaseFromEnvironment();
try {
  const changed = await (action === "fence" ? fenceV1Agent : unfenceV1Agent)(db, tenant, agent, operation);
  if (!changed) {
    throw new Error(action === "fence"
      ? "Agent is missing, has work or v1 integrations, or belongs to another cutover"
      : "No fence owned by that operation");
  }
  console.log(JSON.stringify({ action, tenant, agent, operation }));
} finally {
  await db.end();
}
