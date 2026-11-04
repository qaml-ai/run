// Miniflare 5.20261103.0-beta generates invalid identifiers for string-named exports.
// These names are local-only; the cloud entrypoint retains the required prefix.
export {
  default,
  "camelrun-proto-agent" as LocalRealAgent,
  "camelrun-proto-directory" as LocalRealDirectory,
  "camelrun-proto-deterministic-agent" as LocalDeterministicAgent,
  "camelrun-proto-deterministic-directory" as LocalDeterministicDirectory,
  "camelrun-proto-budget" as LocalModelBudget,
} from "./agent-worker.ts";
