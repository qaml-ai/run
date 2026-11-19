import { WorkerEntrypoint } from "cloudflare:workers";
import worker from "./legacy-mcp-entry.ts";

export * from "../src/index.ts";

export class UnexpectedLegacyOrigin extends WorkerEntrypoint {
  fetch(): Response { throw new Error("Account identity must not call the legacy origin"); }
}

export default worker;
