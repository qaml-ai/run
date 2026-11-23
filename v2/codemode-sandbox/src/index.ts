import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  protected override maxInterruptBudget = 500_000;
  protected override maxMemoryLimitBytes = 32 * 1024 * 1024;
}

export default {
  fetch(): Response {
    return Response.json({ ok: true, service: "camelrun-v2-codemode-sandbox" });
  },
};
