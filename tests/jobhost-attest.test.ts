import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIENCE_HEADER, awsCaller, checkAwsAttestation, signGetCallerIdentity, signingKey, type Attestation } from "../shared/job-host-attest.ts";

// The example keys and the signing-key vector are AWS's own documentation's (SigV4: "Derive a signing key").
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token-example" };
const AUDIENCE = "camelrun-job-host:https://run.example";
const NOW = new Date("2026-11-12T12:00:00Z");
// A GetCallerIdentity answer as STS sends it for an EC2 instance's role (recorded shape; account and ids are examples).
const STS_ANSWER = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:sts::123456789012:assumed-role/camelrun-job-host/i-0abc123def4567890</Arn>
    <UserId>AROAEXAMPLEID:i-0abc123def4567890</UserId>
    <Account>123456789012</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>01234567-89ab-cdef-0123-456789abcdef</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`;

test("SigV4's signing key matches AWS's documented vector", () => {
  assert.equal(signingKey(CREDS.secretAccessKey, "20150830", "us-east-1", "iam").toString("hex"), "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
});

test("a host's signed GetCallerIdentity passes the runtime's checks, and what is sent to STS is only what STS needs", () => {
  const signed = signGetCallerIdentity(CREDS, AUDIENCE, { now: NOW }) as Extract<Attestation, { kind: "aws" }>;
  assert.equal(signed.url, "https://sts.amazonaws.com/");
  assert.match(signed.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261112\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-camelrun-job-host-audience, Signature=[0-9a-f]{64}$/);
  const checked = checkAwsAttestation(signed, AUDIENCE, NOW.getTime() + 60_000);
  assert.equal(checked.url, "https://sts.amazonaws.com/");
  assert.deepEqual(Object.keys(checked.headers).sort(), ["authorization", "content-type", "host", "x-amz-date", "x-amz-security-token", AUDIENCE_HEADER].sort());
  assert.match(checked.signature, /^[0-9a-f]{64}$/);
  // A regional endpoint is STS too.
  assert.equal(checkAwsAttestation(signGetCallerIdentity(CREDS, AUDIENCE, { now: NOW, region: "us-west-2" }) as never, AUDIENCE, NOW.getTime()).url, "https://sts.us-west-2.amazonaws.com/");
});

test("the runtime refuses an attestation that is not a fresh GetCallerIdentity signed for it, before sending anything", () => {
  const signed = signGetCallerIdentity(CREDS, AUDIENCE, { now: NOW }) as Extract<Attestation, { kind: "aws" }>;
  const refuse = (change: Partial<typeof signed>, pattern: RegExp, at = NOW.getTime()) => assert.throws(() => checkAwsAttestation({ ...signed, ...change } as never, AUDIENCE, at), pattern);
  // Somewhere other than STS (the runtime would be the one sending it): refused, whatever is signed.
  refuse({ url: "https://evil.example/" }, /Not an STS request/);
  refuse({ url: "https://sts.amazonaws.com.evil.example/" }, /Not an STS request/);
  refuse({ url: "http://sts.amazonaws.com/" }, /Not an STS request/);
  refuse({ url: "https://sts.amazonaws.com/?Action=AssumeRole" }, /Not an STS request/);
  refuse({ body: "Action=AssumeRole&Version=2011-06-15" }, /Only sts:GetCallerIdentity/);
  refuse({ headers: { ...signed.headers, host: "iam.amazonaws.com" } }, /signed host/);
  // Signed for another runtime, or with the audience left out of the signature.
  assert.throws(() => checkAwsAttestation(signed, "camelrun-job-host:https://other.example", NOW.getTime()), /another audience/);
  refuse({ headers: { ...signed.headers, authorization: signed.headers.authorization!.replace(";x-camelrun-job-host-audience", "") } }, /must be signed/);
  // Too old, or from the future.
  refuse({}, /too old/, NOW.getTime() + 6 * 60_000);
  refuse({}, /too old/, NOW.getTime() - 6 * 60_000);
});

test("STS's answer: an allowed assumed role, the host id its EC2 instance's; anything else is refused", () => {
  assert.deepEqual(awsCaller(STS_ANSWER, ["arn:aws:iam::123456789012:role/camelrun-job-host"]), { host: "i-0abc123def4567890", roleArn: "arn:aws:iam::123456789012:role/camelrun-job-host" });
  // An allowed ARN with a path matches the assumed role's name (its ARN carries no path).
  assert.equal(awsCaller(STS_ANSWER, ["arn:aws:iam::123456789012:role/hosts/camelrun-job-host"]).host, "i-0abc123def4567890");
  assert.throws(() => awsCaller(STS_ANSWER, ["arn:aws:iam::123456789012:role/other"]), /not allowed/);
  assert.throws(() => awsCaller(STS_ANSWER, ["arn:aws:iam::999999999999:role/camelrun-job-host"]), /not allowed/);
  assert.throws(() => awsCaller(STS_ANSWER.replace("assumed-role/camelrun-job-host/i-0abc123def4567890", "user/alice"), ["arn:aws:iam::123456789012:role/camelrun-job-host"]), /Not an assumed role/);
  assert.throws(() => awsCaller(STS_ANSWER.replace("/i-0abc123def4567890</Arn>", "/my-laptop</Arn>"), ["arn:aws:iam::123456789012:role/camelrun-job-host"]), /EC2 instance id/);
  assert.throws(() => awsCaller("<Error>denied</Error>", ["arn:aws:iam::123456789012:role/camelrun-job-host"]), /Not an assumed role/);
});
