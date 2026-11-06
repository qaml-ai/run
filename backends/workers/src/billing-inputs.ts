// Generated request schemas from src/api-schemas.ts; only OpenAPI annotations removed.
import { z } from "zod";
export const BillingAlertChoices = z.object({ low: z.boolean(), depleted: z.boolean(), problems: z.boolean(), receipts: z.boolean() });
export const BillingRecipientInput = z.object({ email: z.email().max(254), events: BillingAlertChoices.optional() });
export const BillingAlertThreshold = z.object({ thresholdUsd: z.number().min(0.01).max(500) });
export const BillingConfirmationInput = z.object({ token: z.string().max(100) });
export const AdjustmentInput = z.object({
    tenant: z.string(),
    amount: z.number().int().refine(value => value !== 0 && Math.abs(value) <= 1e12, "amount must be a non-zero integer of micro-USD"),
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/).optional(),
});
export const StartingCreditGrantInput = z.object({
    tenant: z.string(),
    amountUsd: z.number().min(1).max(100),
    reason: z.string().trim().min(1).max(500),
});
export const BillingPortalInput = z.object({ flow: z.enum(["manage", "payment_method"]).default("manage"), resumeAutoTopup: z.boolean().optional() }).strict();
export const CheckoutInput = z.object({
    requestId: z.uuid().optional(),
    amountUsd: z.number(),
});
export const CardCheckConfirmInput = z.object({ session: z.string() }).strict();
export const AutoTopupTerms = z.object({ thresholdUsd: z.number(), amountUsd: z.number(), monthlyLimitUsd: z.number() }).strict();
export const AutoTopupConsent = z.object({ quoteId: z.uuid(), version: z.string().length(64), consent: z.literal(true) }).strict();
export const AutoTopupRetry = z.object({ attemptId: z.uuid() }).strict();
