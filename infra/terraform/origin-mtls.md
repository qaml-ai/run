# Custom origin authentication for camelRun

This ALB serves `agents.camelai.dev` and `run.camelai.com`. Include
`admin_hostname` when enabled, and any other certificates/hostnames actually
attached to the listener. Every one needs trusted Cloudflare client certificates
before listener-wide enforcement. Coordinate `camelai.com` with camel-bots.

## What this changes

The Cloudflare IP allowlist stays in place. With `origin_mtls_enforced = true`,
the HTTPS listener also requires a valid client certificate signed by the custom
CA bundle in its trust store. The ALB verifies the certificate and its expiry;
`passthrough` is not used. The ACM server certificates remain unchanged.

The trust store contains public CA certificates only. Generate and manage the
CA and client private keys outside Terraform, Git, S3 state and CI logs. Use a
dedicated origin-pull CA, never a general organization CA or Cloudflare's shared
global AOP certificate. A trusted CA can authorize any client certificate it
issues: this is CA-based authentication, not a certificate fingerprint pin.

## Rollout inputs

| Variable | Default | Purpose |
|---|---|---|
| `origin_mtls_ca_bucket` | `null` | Versioned S3 bucket in us-west-2 containing the public CA PEM bundle |
| `origin_mtls_ca_key` | `null` | Object key of that public bundle |
| `origin_mtls_ca_version` | `null` | Exact S3 VersionId; required with bucket and key |
| `origin_mtls_enforced` | `false` | Require client certificates on the HTTPS listener |

Set all three CA fields together; the unversioned S3 VersionId `null` is rejected. Staging them creates a trust store without
requiring client certificates. Setting enforcement without a CA fails planning.
The `origin_mtls` output reports the staged trust store and enforcement flag.
The S3 object must be readable by the operator/provider creating the trust store;
do not make the bucket public. No application task needs access to it.

## Certificate and Cloudflare preparation (operator)

1. Recheck live Cloudflare settings, all hostnames on each ALB, and existing AOP
   configuration. Reuse/coordinate a zone's existing certificate rather than
   overwriting it. The two applications share `camelai.com`.
2. Prefer custom **per-hostname** AOP if available to the account. Verify access
   to its API before provisioning. If using **zone-level** AOP, inventory all
   proxied origins in the zone first: it changes the certificate presented to
   all of them, including unrelated services that may already require mTLS.
   Full (strict) is a separate setting; use hostname-scoped configuration rules
   after checking ACM certificates, rather than changing unrelated origins.
3. Generate a dedicated CA and client leaf certificates using the
   [Cloudflare AWS guide](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/aws-alb-integration/).
   Use RSA 4096 / SHA-256 for ALB compatibility. The CA needs `CA:TRUE` and
   `keyCertSign,cRLSign`; leaf certificates need `CA:FALSE`, `digitalSignature`
   and `extendedKeyUsage=clientAuth`. Keep the CA key encrypted/offline. Set a
   renewal owner, alert at least 30 days before expiry, and verify with
   `openssl verify -purpose sslclient -CAfile origin-ca.pem client.pem`.
   With hostname AOP, use separate app CAs and leaves where practical. With
   zone AOP, both ALBs must trust the CA for `camelai.com`; camelRun must also
   trust the CA for `camelai.dev`. Concatenate the required public CA PEMs into
   each ALB's bundle. Do not infer hostname authorization from a leaf's CN:
   the ALB trust store validates its issuing CA, not a hostname allowlist.
4. Upload **only the public CA bundle** to versioned private S3, record the
   returned VersionId, and stage the three CA inputs with enforcement false.
   Review the plan: the expected infrastructure addition is one trust store,
   plus an explicit `off` listener block/output if not already recorded.
5. Upload the client **leaf certificate and its private key** through the
   appropriate Cloudflare AOP API using an operator-controlled secret channel.
   Do not put keys in Terraform resources: provider-sensitive values may still
   be persisted in state. Never echo API bodies, use shell tracing, or paste
   private material in tickets. Configure certificate expiry notifications.
   Enable the custom certificate for every served hostname (or the audited
   zones). Do not substitute the global `tls_client_auth` toggle: custom zone
   AOP has its own `/origin_tls_client_auth/settings` endpoint.
6. Verify Full (strict) is effective for the intended hostnames and check that
   Cloudflare's AOP API reports the intended custom certificate and enablement.
   Requesting a public health endpoint while ALB authentication is off does
   **not** prove Cloudflare is sending a usable certificate. Verify it against
   a temporary mTLS canary origin behind Cloudflare before enforcing, or use a
   monitored, one-application-at-a-time enforcement window with immediate
   rollback ready. Do not leave the ALB in passthrough mode: the application
   does not validate forwarded client-certificate headers.

## Apply and verify

Use the existing [plan/apply procedure](README.md#plan-and-apply). Fetch
production's current `prod.auto.tfvars` first. Set the three CA inputs in that
file, leave `origin_mtls_enforced = false`, and apply a reviewed saved plan.
After Cloudflare preparation and verification, change only enforcement to true
and apply another reviewed saved plan. Persist the updated production settings
back to their existing S3 location after each successful apply. Roll back by
setting enforcement false and applying while retaining the three CA inputs.
Never use the unrelated `prod.auto.tfvars` in the repository's parent directory.

Review the full plan with production's existing settings; never apply a plan
built from defaults alone. Application counts, secrets, DNS, databases and task
definitions should not change as part of enabling mTLS. Stage and enforce in
separate applies. Do not apply both applications at once.

After each enforcement apply:

- Read the HTTPS listener back with `aws elbv2 describe-listeners`: mode must
  be `verify`, the trust store must match, and expiry must not be ignored.
- Check all hostnames' `/healthz` through Cloudflare, login/OAuth, incoming
  webhooks, streaming and the application's main user flow. For camel-bots,
  include Discord interactions, builder chat and camelRun callbacks. For
  camelRun, include the console, API and SSE responses. Watch ALB and
  Cloudflare TLS/5xx errors and availability alarms.
- Test from an approved path allowed by the ALB security group: no client cert
  must fail TLS; an unrelated client CA must fail; the intended client cert
  must succeed. Keep the application's hostname as SNI, e.g. curl
  `--connect-to HOST:443:ALB_DNS:443 https://HOST/healthz` with/without the
  client certificate. Do not open the origin to the internet for this test.
  A direct request from an ordinary laptop that merely times out proves the
  IP allowlist works, not that mTLS works.
- The port 80 listener still only redirects to HTTPS. It never forwards to
  the application; mTLS protects HTTPS requests, not the redirect response.
  Internal ALB health checks and private node-to-node traffic do not go
  through the HTTPS listener and do not need these client certificates.

## Rollback and rotation

Set `origin_mtls_enforced = false`, apply and read the listener back as `off`.
Keep the CA inputs in place: rollback does not delete the trust store. Restore
availability at the ALB before disabling Cloudflare's certificate presentation.
This rollback restores IP-allowlist-only protection, so investigate and retry.

To rotate a CA, first upload a bundle containing old and new public CAs and
apply its new VersionId to every affected ALB. Then rotate Cloudflare leaves,
verify traffic, and finally remove the old CA in another versioned bundle.
Rotating a leaf under the same CA needs no ALB trust change. For compromise,
remove compromised trust or add an ALB revocation list as appropriate; routine
overlap rotation is not immediate revocation. Revocation-list management is
not implemented by this change. Do not delete a trust store while a listener
still references it.

## Local validation

```sh
cd infra/terraform
tofu init -backend=false -input=false -lockfile=readonly
tofu fmt -check
tofu validate
tofu test -filter=tests/origin-mtls.tftest.hcl
```

Tests mock cloud providers and target only the listener's dependency graph.
They check the availability-preserving defaults, staged CA, enforced CA and
expiry verification, and rejection of missing/incomplete/unpinned CA inputs.
They do not prove a real Cloudflare-to-ALB TLS handshake.

References: [custom zone AOP](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/zone-level/),
[custom hostname AOP](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/per-hostname/),
[ALB mTLS](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/configuring-mtls-with-elb.html).
