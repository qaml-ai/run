# Applying the experiment to ECS

This is a proposed integration, not a change to the ECS runtime. Source paths and
behavior below were checked against this branch. Keep Pi unmodified and retain
the existing process, ownership, outbound-network, billing and sandbox boundaries.

## Integration points

| Existing code | Change needed |
| --- | --- |
| `src/agent-host.ts:fittedBlock` / `fittedImages` | After the existing image inspection and isolated resize, persist the derivative through the supervisor and return a compact marker. Recognize trusted markers before decoding them as ordinary image bytes. A marker is transport metadata, not an image supplied by a user. |
| `src/agent-host.ts:agentTools` content result path | Externalize each fitted tool image before its result enters Pi. Preserve structured tool output and errors. Tools called inside codemode need the same rule at the final visible image result boundary. |
| `src/agent-host.ts:codeMode` | Externalize the fitted `result.output` images here. Preserve `outputFiles` and the workspace file; a marker must not become the contents of the image file that a later `read` returns. |
| `src/agent-host.ts:userMessages`, prompt and steer paths | Validate the original incoming image, persist original/derivative metadata, then replace its data before journal append. Apply it to both ordinary prompts and queued steering. |
| `src/agent-host.ts:fileData` / `hydrate` | Existing `FileRef` attachments already retain immutable chunk references. For images, produce a derivative reference or marker rather than a fitted base64 string. Keep document/PDF handling separate. |
| `src/agent-host.ts:HostIO.file`; supervisor storage/IPC | Add a capability-scoped image-store/read interface. `file` currently returns one complete base64 string, so wrapping provider fetch alone leaves this allocation and IPC copy intact. Prefer signed URL construction in the supervisor, or a bounded stream/chunk protocol from the supervisor to the host. Do not give every host the bucket credential. |
| `src/compaction.ts:authorize`, `azureOptions`, `callFetch` | Compose image substitution with the existing per-call fetch. Keep URL rebasing, tenant endpoint outbound policy, explicit key selection, generation IDs and usage/cost observation. Apply it to normal calls, fallback calls and compaction summaries. |
| `src/pi-durable/agent.ts:attempt` and token telemetry | Retain original derivative dimensions/count/size outside the marker. The marker's encoded length must not become the request-byte budget or image-token estimate. Apply the same estimates to held and sent context metrics. |
| `src/pi-durable/fork.ts`, export/import and deletion | Retain referenced bytes across forks and exports. Transfer or reissue authorization on import. Extend the existing chunk-pin ownership model to derivatives and delete only after all retained history/forks release them. |

`src/agent-host.ts:hydrate` currently budgets newest images first, with a
20 MiB base64 request budget and 40 images, or 90 for Anthropic
(`src/limits.ts`, `src/request-images.ts`). It also triggers compaction when
inline images are omitted. Keep that behavior and calculate each reference's
base64 contribution as `4 * ceil(encodedDerivativeBytes / 3)`. Streaming permits
a bounded-memory request; it does not increase a provider's accepted image
count, request bytes, pixel limits or context window. The existing hydration
cache is 32 MiB; replacing its image values with metadata would remove another
retained base64 copy.

## Recommended transport

Use signed URLs for specifically verified provider/API/model combinations. Use
in-process streaming substitution for base64-only HTTP adapters that honor Pi's
per-request fetch. On Node, send a rebuilt `ReadableStream` or `Readable` body
with `duplex: 'half'` where required, and set the exact `Content-Length`. Native
`FixedLengthStream` is a Workers primitive and needs a Node transport adapter.
Preserve backpressure, abort propagation and a fresh object read on every retry.

A separate proxy remains an option when a dedicated credential/egress boundary
or centralized transport is wanted. It adds an extra service dependency and
requires scoped image read authorization. It does not remove the need to keep
markers in the host journal. Do not introduce it merely to stream bytes that a
Node host can stream itself.

The transport must run after the provider-specific request shape is determined,
while preserving `callFetch`'s network guard and response accounting. Installing
an independent fetch that bypasses `authorize` would discard explicit tenant
credentials, keyless gateway behavior, per-call identities, URL rebasing and
usage capture. Provider fallback can change the image shape and capability; pick
the transport for the actual attempted provider, not only the agent's initial
model.

## Bedrock, Google and integrity limits

Use Bedrock API keys over bearer HTTPS; request signing and two-pass hashing are
outside the proposed integration. Pi 1.5.0's native Bedrock adapter already
supports bearer tokens, but still does not consume `options.fetch`. For native
Converse, add an application-owned adapter that builds small marker JSON, posts
it with bearer auth, and expands `image.source.bytes` into base64 once per
attempt. Preserve the trusted image `format`. Native Converse accepts bytes
or supported S3 references, not arbitrary signed HTTP image URLs. See the
[Bedrock source and API audit](provider-audit.md#bedrock-api-key-http-transport).

The adapter must preserve system messages, tools, reasoning, cache metadata,
usage, errors and cancellation while decoding the native response event stream.
The shared stream builder covers the request-byte transformation only. The
bearer request-shape fixture is not a complete Pi adapter or AWS acceptance
test. Where the exact Bedrock model supports its OpenAI-compatible API and
image inputs, routing through the existing OpenAI adapter may avoid that native
response implementation; verify those capabilities before selecting it.

The tested Google adapters explicitly reject a custom fetch. Their request path
needs an application transport or a supported provider-specific file reference;
this experiment does not solve that path. Do not put marker images on an
unsupported adapter: a valid PNG marker could otherwise reach a real model as a
blank 1x1 image without an obvious protocol error.

The current marker is itself a small PNG so Pi's image-header checks accept it.
The experiment stores PNG derivatives. The stream builder also restores JPEG
and WebP MIME/data-URL prefixes and native image formats from reference metadata,
with synthetic unit coverage. An ECS integration must retain that translation
and validate the metadata against the stored derivative; its hash and format
cannot be trusted merely because they appear in a marker.

Marker metadata is not authorization. Before expanding or signing it, resolve
an opaque reference under the current tenant/agent's retained-image capability;
validate size, MIME, hash and derivative version against stored metadata. Reject
forged keys and cross-tenant references. Use write-once content-addressed objects
or a pinned version/ETag. The prototype checks object length and verifies hashes
at its fake receiver, but its general streaming wrapper does not independently
hash or authenticate each reference before sending.

## Rollout work

1. Add the store/capability and Node streaming adapter with targeted tests for
   direct images, tool images, codemode files, prompts and steering.
2. Verify restart, compaction, fork/export/import and retention/deletion under
   both process and inline hosting modes. Keep existing attachment behavior.
3. Gate per transport, retain existing byte/count limits, and measure held heap,
   request heap, cancellation, retries, missing objects and quality on real
   provider vision calls. Unsupported adapters must fail closed or use a bounded
   explicitly supported fallback.
4. Treat old inline history as a separate migration. Process a bounded entry at
   a time, preserve journal/fork cursors, retain originals, and compare replay
   before allowing reclamation. An afterTool hook cannot repair already loaded
   historical base64 by itself.
