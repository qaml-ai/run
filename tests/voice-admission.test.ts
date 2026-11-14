import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http.ts";
import { voiceAdmission } from "../src/voice-sessions.ts";
import { spendRefusal } from "../src/voice/realtime/brain.ts";
import { FREE_HOURLY_LIMIT } from "../src/billing.ts";

// Every voice path (calls, realtime and listening sessions) admits through voiceAdmission: free credit stays bounded
// by its hourly allowance, and each refusal is a spend refusal that ends a call as budget.
test("voice admission refuses the free hourly allowance (429 FREE_HOURLY_LIMIT), no credit and a spend limit, each a spend refusal", async () => {
  const refusals: (string | HttpError | undefined)[] = [
    new HttpError(429, "free credit limit; try again later", FREE_HOURLY_LIMIT),
    new HttpError(402, "out of credit", "INSUFFICIENT_CREDIT"),
    "This account reached its spend limit",
  ];
  for (const refused of refusals) {
    const admit = voiceAdmission({ runLimit: async () => refused });
    await assert.rejects(admit("t"), (error: HttpError) => spendRefusal(error), String(refused));
  }
  await assert.rejects(voiceAdmission({ runLimit: async () => refusals[0] })("t"), (error: HttpError) => error.status === 429 && error.code === FREE_HOURLY_LIMIT);
  await voiceAdmission({ runLimit: async () => undefined })("t");
});
