import assert from "node:assert/strict";
import test from "node:test";
import { computerSettingsInput } from "../src/computers/settings.ts";

const check = (value: unknown) => {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  return url;
};
const exchange = { type: "exchange" as const, url: "https://app.example.net/token" };

test("computer settings: hosts are public DNS names, auth is an exchange, scheme needs auth", () => {
  assert.deepEqual(computerSettingsInput({ egress: [{ host: "github.com", auth: exchange, scheme: "basic" }, { host: "registry.npmjs.org" }], idleSeconds: 900, instance: "standard-2" }, check, "acme"), {
    egress: [{ host: "github.com", auth: { type: "exchange", url: "https://app.example.net/token" }, scheme: "basic" }, { host: "registry.npmjs.org" }],
    idleSeconds: 900,
    instance: "standard-2",
  });
  // An exchange grant defaults to a bearer header.
  assert.equal(computerSettingsInput({ egress: [{ host: "api.github.com", auth: exchange }] }, check, "acme").egress![0].scheme, "bearer");
  for (const [value, message] of [
    [[], /must be an object/],
    [{ network: true }, /Unrecognized key: "network"/],
    [{ idleSeconds: 5 }, /idleSeconds must be an integer from 10 to 3600/],
    [{ instance: "huge" }, /instance must be one of lite, standard-1/],
    [{ egress: [{ host: "GitHub.com" }] }, /public DNS name/],
    [{ egress: [{ host: "github.com:443" }] }, /public DNS name/],
    [{ egress: [{ host: "*.github.com" }] }, /public DNS name/],
    [{ egress: [{ host: "10.0.0.1" }] }, /public DNS name/],
    [{ egress: [{ host: "metadata.internal" }] }, /public DNS name/],
    [{ egress: [{ host: "localhost" }] }, /public DNS name/],
    [{ egress: [{ host: "github.com" }, { host: "github.com" }] }, /listed twice/],
    [{ egress: [{ host: "github.com", scheme: "basic" }] }, /scheme needs auth/],
    [{ egress: [{ host: "github.com", auth: { type: "bearer", token: "x" } }] }, /type: "exchange"/],
    [{ egress: [{ host: "github.com", auth: { ...exchange, url: "http://app.example.net/token" } }] }, /auth.url: Only https/],
    [{ egress: [{ host: "github.com", auth: { ...exchange, audience: "https://other.example.org" } }] }, /audience/],
    [{ egress: Array.from({ length: 33 }, (_, i) => ({ host: `h${i}.example.net` })) }, /at most 32/],
  ] as const) assert.throws(() => computerSettingsInput(value, check, "acme"), message as RegExp);
});

test("computer settings: a github-app grant names one of the tenant's Apps, is for GitHub's hosts, and defaults to git's Basic on github.com", () => {
  const app = { type: "github-app", app: "code", repositories: ["Acme/App"], permissions: { pull_requests: "write", contents: "write" } };
  assert.deepEqual(computerSettingsInput({ egress: [{ host: "github.com", auth: app }, { host: "api.github.com", auth: { type: "github-app", app: "code", owner: "acme" } }] }, check, "acme").egress, [
    { host: "github.com", auth: { type: "github-app", app: "code", repositories: ["acme/app"], permissions: { contents: "write", pull_requests: "write" } }, scheme: "basic" },
    { host: "api.github.com", auth: { type: "github-app", app: "code", owner: "acme" }, scheme: "bearer" },
  ]);
  assert.equal(computerSettingsInput({ egress: [{ host: "github.com", auth: app, scheme: "bearer" }] }, check, "acme").egress![0].scheme, "bearer");
  for (const [value, message] of [
    [{ egress: [{ host: "registry.npmjs.org", auth: app }] }, /auth github-app is for GitHub's hosts: github\.com, api\.github\.com/],
    [{ egress: [{ host: "github.com", auth: { type: "github-app" } }] }, /computer\.egress\[0\]\.auth\.app is the name or id/],
    [{ egress: [{ host: "github.com", auth: { ...app, url: "https://x.example.net" } }] }, /Unrecognized key: "url"/],
    [{ egress: [{ host: "github.com", auth: { ...app, repositories: ["acme/a", "other/b"] } }] }, /must all have one owner/],
  ] as const) assert.throws(() => computerSettingsInput(value, check, "acme"), message as RegExp);
});
