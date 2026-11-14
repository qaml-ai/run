import { createHash } from "node:crypto";
export const keyedRepoId = (tenant: string, key: string) => "repo_" + createHash("sha256").update(`repo-key:${tenant}:${key}`).digest("hex").slice(0,24);
export const agentRepoId = (tenant: string, agent: string) => keyedRepoId(tenant,`agent:${agent}`);
