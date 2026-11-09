/** Environment owned by the HTTPS interception gateway, shared with vault name validation. */
export const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
export const EGRESS_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: CONTAINER_CA,
  GIT_TERMINAL_PROMPT: "0",
  SSL_CERT_FILE: SYSTEM_BUNDLE,
  REQUESTS_CA_BUNDLE: SYSTEM_BUNDLE,
  PIP_CERT: SYSTEM_BUNDLE,
};
export const RESERVED_SECRET_NAMES = new Set(["PATH", "HOME", "NODE_OPTIONS", ...Object.keys(EGRESS_ENV)]);
