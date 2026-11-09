import { workerVault } from "../vault.ts";
import type { VaultAuth, Networking } from "../../../../src/core/vault.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../agent-types.ts";
import { credentialExchange } from "../exchange-auth.ts";
import { fetchSource, sourceUrl } from "../tool-sources.ts";
import type { IdentityEnv } from "../tool-identity.ts";
import { modelOutbound } from "../security-outbound.ts";
import { testEndpoint } from "./microvm.ts";
import { forwardEgress, grantSource, type EgressGrant, type EgressIdentity } from "./egress.ts";
import { workerGitHubApps, type GitHubAppsEnv } from "../github-apps.ts";

export type EgressProps = { grant: EgressGrant; identity: EgressIdentity; secrets?: VaultAuth[]; networking?: Networking; mcpHosts?: string[] };

/**
 * One granted host of one agent's computer. The computer object registers it with interceptOutboundHttps, with the
 * grant and the agent's identity as props, so a request can only reach the host it was registered for and only with
 * that agent's credential.
 */
export class ComputerEgress extends WorkerEntrypoint<Env, EgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const { grant, identity } = this.ctx.props;
    const env = this.env;
    const testUpstream = testEndpoint((env as { TEST_EGRESS_UPSTREAM?: string }).TEST_EGRESS_UPSTREAM, env);
    const policy = modelOutbound(env as unknown as Record<string, unknown>);
    const vault = await workerVault(env);
    return forwardEgress(request, grant, {
      vault: { service: vault, tenant: identity.claims.tenant, refs: this.ctx.props.secrets ?? [] },
      testUpstream, networking: this.ctx.props.networking, mcpHosts: this.ctx.props.mcpHosts,
      async credential(authed) {
        // The tenant's own App, by the agent's tenant: another tenant's App of the same name is never found.
        if (authed.auth.type === "github-app") return (await workerGitHubApps(env as unknown as GitHubAppsEnv)).token(identity.claims.tenant, authed.auth, `https://${authed.host}`);
        if (authed.auth.type === "vault") return { token: await vault.open(identity.claims.tenant, authed.auth, new URL(request.url), "header"), refused() {} };
        const exchange = credentialExchange(env as unknown as IdentityEnv, grantSource({ ...authed, auth: authed.auth }), async () => identity,
          (url, init, max) => fetchSource(env, sourceUrl(url, env), init, max));
        const headers = await exchange.headers();
        return { token: headers.Authorization.replace(/^Bearer /, ""), refused: () => exchange.refused() };
      },
      async send(upstream) {
        // A granted host is a public name; the runtime's outbound rules still apply to where it resolves.
        if (!testUpstream) await policy.reachable(upstream.url);
        return fetch(upstream);
      },
    });
  }
}
