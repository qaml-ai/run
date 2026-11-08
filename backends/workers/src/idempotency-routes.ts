// Generated from src/api.ts; only infrastructure imports are adapted.
// Run node backends/workers/scripts/reuse-http.mjs --check to reject source drift.
export const skipMoneyIdempotency: (path: string) => boolean = path => path === "/v1/agents" || path === "/v1/definitions" || path === "/v1/runs" || path === "/v1/transcriptions" || path === "/v1/images" || path === "/v1/speech" || path === "/v1/decisions" || /^\/v1\/agents\/[^/]+\/(?:prompt|fork)$/.test(path);
export const secretMoneyIdempotency: (path: string) => boolean = path => /^\/v1\/(?:tokens|tenants|webhooks|webhooks\/[^/]+\/secret|usage-webhook\/secret|agents\/[^/]+\/(?:browser-tokens|links|share-links|credentials\/rotate)|volumes\/[^/]+\/links)$/.test(path);
