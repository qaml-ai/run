# Final Workers gap trace

This trace starts with the 25 failures at `ff848798`, after group PRs
[#654](https://github.com/qaml-ai/run/pull/654),
[#655](https://github.com/qaml-ai/run/pull/655),
[#657](https://github.com/qaml-ai/run/pull/657),
[#658](https://github.com/qaml-ai/run/pull/658),
[#659](https://github.com/qaml-ai/run/pull/659) and
[#660](https://github.com/qaml-ai/run/pull/660).
The generated [scorecard](../PARITY.md) contains the final per-case results.
Original contract assertions and their explicit timeouts are unchanged.

## Integration seams

| Original failure | Source trace and correction |
| --- | --- |
| Definition and agent language inheritance | #659, `79c62fb4`, combined with #658's definition application. Preserve an explicit agent override and allow an explicit definition null to clear inheritance. |
| Models chosen by name over REST | #658, `b93119d8`, and later configuration admission validation. Keep provider-key failure in the accepted configuration's outcome; do not replace that contract with an eager HTTP error. |
| Lookup metadata and provider request routing | #659, `069db299`, re-resolved a prepared model at admission; #660, `d677202f`, also used that path. Carry `resolvedModel` through admission. Preserve the already selected native protocol instead of applying the fixture protocol again. |
| Lookup price reaches the end-user hold | Same admission re-resolution. Keeping the prepared model also keeps its trusted lookup price for the hold. |
| Codex on a tenant endpoint | Same prepared-model seam. Preserve the Codex protocol and its subscription accounting exception. |
| Unbilled administrator usage costs | #660's metering path conflated platform key ownership with prepaid catalog pricing. Persist the prepaid pricing decision independently in each receipt; retain provider-reported costs for unbilled tenants. |
| Decisions on a tenant's OpenRouter key | #660, `c40e3fbb`, treated administrator-owned credentials as platform credentials. Auxiliary calls charge only a platform-owned key. |
| X search on tenant keys | Same auxiliary credential ownership seam. |
| Search on operator-configured tenant keys | Same auxiliary credential ownership seam. |
| Address and tenant rate limits | #660, `007381cd`, cached account services before refreshing the limiter's request-scoped accounts. Refresh policy before returning cached services. Both rate-limit paths use that policy. |
| Subscriber abandoned before headers | Bounds from #660, `007381cd` / `0b0c49e2`, meet #659's local proxy, `788e5424`. The proxy's graceful upstream close did not notify workerd of abandonment. Preserve reset semantics in the fixture, pass the abort signal through the DO fetch, and use native stream piping to release slots on downstream cancellation. The deployed FIN check is recorded separately. |
| Schedule creation, listing, cancellation and wake-up | The original failure was the first list, after a one-second schedule had already fired. Schedule storage/list/delete code did not change in this branch. #660, `39c6ade4`, added synchronous billing settlement before reporting completion and #659 added configuration reads, but no timing trace establishes either as the cause. Focused reruns pass unchanged; attribution remains unproven. |
| MCP alias browser redirect | #659, `68030c4a`, intercepted the root before canonical account-origin routing. Redirect browser pages using the configured public origin while keeping alias MCP resource identity. |
| Python synchronous client | The faulty long poll predates the six groups (`62d3d991`); the integrated sync-client case exposed it. Wait for the public request record, which can complete with human input before the model task finishes. The unchanged 30-second case completed in 13.54 seconds in the focused check. |

## Judged tools

The six judge failures also exposed #660's auxiliary credential ownership bug:
the tenant's own key was refused for insufficient platform credit and the judge
safely fell back to asking. The judge and tool gate now live in
`src/core/tool-judge.ts`, with small host adapters. Both runtimes use the same
decision thresholds, denial result, approval bypass, description truncation and
originating-request handling.

| Original failure | Required behavior retained by the shared implementation |
| --- | --- |
| Ordinary call | Run without asking, with the request and arguments visible to the judge. |
| Exfiltration | Return the denial as the tool result; do not run the call. |
| Unsure judge | Ask the person and run an approved call without judging it again. |
| Unavailable judge | Ask the person before running anything. |
| Resumed turn | Judge later calls against the request that originated the turn. |
| Long description | Give the judge the same truncated description as the model. |

## Reviewed differences

These five cases retain their Node assertions and receive the separate Workers
`accepted-difference` status. The sole decision/reason registry is
[`tests/contract/accepted-differences.mjs`](../../../tests/contract/accepted-differences.mjs).

- V8 for every tenant and refusal of an engine option.
- Recovery from versioned Postgres agent headers.
- Failure to write the Postgres pending-work mark.
- Oversized resumed history and Postgres recovery fields.
- ECS load-balancer keep-alive and drain.
