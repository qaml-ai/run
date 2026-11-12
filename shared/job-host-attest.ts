// How a job host proves who it is to the runtime (docs/design/job-hosts-plan.md, slice 4). The host sends an
// attestation; the runtime checks it with an attestor and issues a short-lived credential bound to the host id the
// attestation proves (never one the host names). Two attestors:
//
// - "aws": a signed sts:GetCallerIdentity request, the pattern Vault's AWS auth uses. The host signs the request with
//   its instance role (SigV4) and sends it unsent; the runtime checks its shape (an STS endpoint, that action, a fresh
//   date, the runtime's audience signed in), sends it to STS itself, and reads who signed it. The caller must be an
//   assumed role on the allowlist (JOB_HOST_ROLE_ARNS); the host id is the role session name (an EC2 instance id). A
//   request is accepted once: a captured one cannot be replayed.
// - "test": a shared test secret, for fake mode in tests (TEST_MODE only).
import { createHash, createHmac } from "node:crypto";

export const AUDIENCE_HEADER = "x-camelrun-job-host-audience";
const STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15";
const STS_HOST = /^sts(\.[a-z]{2}(-gov)?-[a-z]+-\d)?\.amazonaws\.com$/;
/** A signed request older (or newer) than this is refused, well inside STS's own 15 minutes. */
export const AWS_ATTESTATION_SKEW_MS = 5 * 60_000;

export type Attestation =
  | { kind: "aws"; method: "POST"; url: string; headers: Record<string, string>; body: string }
  | { kind: "test"; host: string; secret: string };

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** SigV4's signing key (AWS's derivation: secret → date → region → service → aws4_request). */
export function signingKey(secret: string, day: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

/** The host's side: sign sts:GetCallerIdentity (SigV4) for `audience`, and hand it over unsent. */
export function signGetCallerIdentity(credentials: AwsCredentials, audience: string, options: { region?: string; now?: Date } = {}): Attestation {
  const region = options.region ?? "us-east-1", host = region === "us-east-1" ? "sts.amazonaws.com" : `sts.${region}.amazonaws.com`;
  const now = options.now ?? new Date(), amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ""), day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8", host, "x-amz-date": amzDate, [AUDIENCE_HEADER]: audience,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonical = ["POST", "/", "", ...names.map(name => `${name}:${headers[name]!.trim()}`), "", names.join(";"), sha256(STS_BODY)].join("\n");
  const scope = `${day}/${region}/sts/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = signingKey(credentials.secretAccessKey, day, region, "sts");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return { kind: "aws", method: "POST", url: `https://${host}/`, headers, body: STS_BODY };
}

export class AttestationError extends Error {}

/**
 * The runtime's side, before sending anything: an STS endpoint (never another host: no request goes anywhere else),
 * GetCallerIdentity only, a date within the skew, and the runtime's audience among the signed headers, so a request
 * signed for another service or another runtime is not one this runtime accepts. Answers what to send STS: the
 * headers it needs, nothing else.
 */
export function checkAwsAttestation(attestation: Extract<Attestation, { kind: "aws" }>, audience: string, now = Date.now()) {
  let url: URL;
  try { url = new URL(attestation.url); } catch { throw new AttestationError("Not a URL"); }
  if (attestation.method !== "POST" || url.protocol !== "https:" || !STS_HOST.test(url.hostname) || url.pathname !== "/" || url.search || url.port)
    throw new AttestationError("Not an STS request");
  if (attestation.body !== STS_BODY) throw new AttestationError("Only sts:GetCallerIdentity is accepted");
  const headers = Object.fromEntries(Object.entries(attestation.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
  if (headers.host !== url.hostname) throw new AttestationError("The signed host is not the request's");
  if (headers[AUDIENCE_HEADER] !== audience) throw new AttestationError("Signed for another audience");
  const signed = /SignedHeaders=([a-z0-9;-]+)/.exec(headers.authorization ?? "")?.[1]?.split(";") ?? [];
  if (!headers.authorization?.startsWith("AWS4-HMAC-SHA256 ") || !signed.includes(AUDIENCE_HEADER) || !signed.includes("host") || !signed.includes("x-amz-date"))
    throw new AttestationError("The audience, host and date must be signed");
  const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(headers["x-amz-date"] ?? "");
  if (!date) throw new AttestationError("No signing date");
  const at = Date.UTC(+date[1]!, +date[2]! - 1, +date[3]!, +date[4]!, +date[5]!, +date[6]!);
  if (Math.abs(now - at) > AWS_ATTESTATION_SKEW_MS) throw new AttestationError("The signature is too old");
  const send: Record<string, string> = {};
  for (const name of ["authorization", "content-type", "host", "x-amz-date", "x-amz-security-token", AUDIENCE_HEADER]) if (headers[name] !== undefined) send[name] = headers[name]!;
  return { url: url.toString(), headers: send, body: STS_BODY, signature: sha256(headers.authorization!) };
}

/**
 * Who signed it, from STS's answer: an assumed role on the allowlist (its role ARN, as `arn:aws:iam::<account>:role/
 * <path/name>`), and the session name as the host id: an EC2 instance's role session is its instance id.
 */
export function awsCaller(response: string, allowedRoles: string[]) {
  const arn = /<Arn>([^<]+)<\/Arn>/.exec(response)?.[1];
  const match = arn ? /^arn:(aws|aws-us-gov|aws-cn):sts::(\d{12}):assumed-role\/([^/]+)\/([^/]+)$/.exec(arn) : null;
  if (!match) throw new AttestationError("Not an assumed role");
  const [, partition, account, role, session] = match;
  const roleArn = `arn:${partition}:iam::${account}:role/${role}`;
  // An assumed role's ARN carries the role's name, not its path: an allowed ARN matches on partition, account and name.
  const key = (value: string) => { const m = /^arn:([^:]+):iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/.exec(value.trim()); return m ? `${m[1]}:${m[2]}:${m[3]}` : undefined; };
  if (!allowedRoles.map(key).includes(`${partition}:${account}:${role}`)) throw new AttestationError(`Role ${roleArn} is not allowed`);
  if (!/^i-[0-9a-f]{8,17}$/.test(session!)) throw new AttestationError("The role session is not an EC2 instance id");
  return { host: session!, roleArn };
}
