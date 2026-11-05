# Pinned Pi transport and marker audit

Checked the installed, unmodified `@earendil-works/pi-ai`, `pi-durable`, and
`pi-codemode` **1.5.0** packages. These findings describe this pin, not every
future Pi release. The repository's vendored Pi snapshot is separately labeled
`1.5.0-main.f9a263655681`; the experiment installs the exact registry versions
in its own lockfile. Source paths below are relative to the installed package's
`dist/` directory.

| Adapter | Custom per-request fetch | Marker transport implication |
| --- | --- | --- |
| `anthropic-messages` | Yes. `api/anthropic-messages.js` passes `options.fetch` to SDK construction, including federation clients. | Base64 source data can be replaced by the streamed body; direct API supports URL sources. |
| `openai-completions` | Yes. `api/openai-completions.js` passes `options.fetch` to `new OpenAI`. | `image_url.url` data URLs are eligible for stream or URL substitution. |
| `openai-responses` | Yes. `api/openai-responses.js` passes `options.fetch` to `new OpenAI`. | `input_image.image_url` data URLs are eligible. WebSockets are a separate path and are not covered by this wrapper. |
| OpenRouter | Uses `openai-completions` via `providers/openrouter.js`. | Same fetch seam; endpoint/model limits and URL fetching remain provider-specific. |
| DeepSeek-style OpenAI endpoint | Uses `openai-completions`; built-in DeepSeek provider uses that adapter. | Same transport seam does **not** establish vision support for a model whose inputs are text only. |
| `azure-openai-responses` | Yes. `api/azure-openai-responses.js` passes `fetch: options.fetch` to `AzureOpenAI`. | Same Responses image shape; deployment must support vision. |
| `google-generative-ai` | Explicitly rejects non-default fetch before constructing the client. | This technique cannot transparently attach at the requested seam. |
| `google-vertex` | Explicitly rejects non-default fetch before constructing the client. | Same limitation. |
| `bedrock-converse-stream` | Ignores `options.fetch`, constructs `BedrockRuntimeClient`. Its image converter decodes data to bytes before SDK serialization. | API-key bearer auth is already supported, but does not expose a fetch seam. Use an application-owned bearer HTTP adapter for native Converse, or a verified compatible API/model through an existing HTTP adapter. |

The declared `ProviderRequestOptions.fetch` documentation explicitly allows
adapters that cannot inject it to reject it. Its presence in a TypeScript
interface does not prove support for every provider.

## Bedrock API-key HTTP transport

The intended Bedrock integration uses **API keys and bearer HTTPS only**.
There is no request-signing or two-pass hashing requirement. AWS documents
`Authorization: Bearer` for Bedrock API keys and gives a direct HTTPS Converse
example. See [AWS API-key authentication](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html).

The pinned `api/bedrock-converse-stream.js` already resolves
`options.bearerToken`, then `options.apiKey`, then `AWS_BEARER_TOKEN_BEDROCK`;
it configures the SDK token and `httpBearerAuth` preference. However,
`createImageBlock` decodes `data` into a `Uint8Array`, and the adapter calls
`client.send(new ConverseStreamCommand(...))`. It never consumes
`options.fetch`. Changing the authentication mode alone therefore cannot
attach this experiment's transport to the stock adapter.

For native Converse, an application-owned adapter can POST marker JSON to
`/model/{modelId}/converse-stream`, set the bearer header, then expand
`messages[].content[].image.source.bytes` while writing the request. The image
block also needs its trusted `format` (`png`, `jpeg`, `gif`, or `webp`). The
native image-source union accepts base64 bytes or a supported S3 location;
it has no generic HTTP URL member, so D is not a native Converse transport.
See [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html),
[ImageBlock](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ImageBlock.html), and
[ImageSource](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ImageSource.html).

AWS also documents OpenAI-compatible
`/openai/v1/chat/completions` and `/openai/v1/responses` on its runtime endpoint.
These provide a potentially smaller integration through Pi's existing OpenAI
HTTP adapters. This is an inference from the documented API compatibility and
the tested fetch seam, not a Bedrock test. Select the API, region and model
explicitly; compatible endpoint availability does not prove image or URL
support. See [AWS Chat Completions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html)
and [AWS Responses](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html).

`tests/bedrock.test.ts` checks a synthetic bearer request and native Converse
image JSON through the shared stream builder, with no AWS access. It does not
implement a Pi adapter, decode native response events, or establish AWS
acceptance. Native integration still needs Pi message/tool conversion,
response-event decoding, usage/error mapping, retry/abort behavior and live
vision verification. The historical SigV4 test was removed when the experiment
scope became bearer-only.

## Validation and limits

Pi's code mode `runtime/prelude-source.js` rejects remote URL image outputs,
requires padded base64 syntax, and checks the PNG/JPEG/GIF/WebP magic prefix.
An ordinary base64-encoded `ref:...` string fails `image(marker)`. The experiment
therefore uses a complete tiny PNG with a CRC-checked iTXt reference chunk.
The bytes remain a valid image until transport substitution. This is a private
protocol carried through the existing image field; applications must not expose
the tiny PNG as if it were the original screenshot.

`pi-durable/harness/tool.js` applies `afterTool` before final `boundContent`.
Nested tools without an explicit output schema rebuild their result from the
bounded output, but code mode passes only their text to scripts. Native Pi
`read` declares an image-aware output schema. The probe uses the same schema,
so a nested read returns the marker and `image(await tools.read(...))` exercises
Pi's normal validation.
The host must enforce original/derivative byte and pixel limits **before**
replacing the data. Pi's general `boundContent` truncation bounds text only
and is not an image safety limit. Native Pi `read` separately checks encoded bytes and dimensions
(or invokes its configured image processor) before this hook. An explicit tool
`structuredOutput` can also contain the original image; the prototype hook
normalizes both the output and the schema-aware image value.

Pi's `codemode/output.js` decodes every emitted image and writes it as an artifact
when an execution filesystem is available. Without host translation, it writes
the **marker PNG**, not the original. Image UI/export/file paths need the same
reference resolution and authorization as provider requests. The probe records
whether its no-filesystem run reports that saving was unavailable; that is not
a complete artifact implementation.

## Token estimation and compaction

`pi-ai/utils/estimate.js` assigns every image **4,800 estimated characters**,
then divides by **3.5 characters/token**, rounded up: one image alone is
**1,372 estimated tokens**. It does not inspect image base64 length or pixels.
The original and marker receive the same estimate, so replacing bytes does not
make images disappear from this heuristic. It still cannot predict each
provider's resolution/tiling costs. `estimateContextTokens` prefers the most
recent trustworthy assistant usage and estimates only trailing messages; fake
provider usage is unsuitable for evaluating production compaction thresholds.

The cloud probe runs the actual Harness over DO SQLite, input submission,
`afterTool`, nested `read`, code mode `image`, fork, manual compaction, and
close/reopen. It also executes native `createReadTool` against a fixed binary
reader fixture: a small PNG succeeds, 5 MiB metadata is refused before a full
body read, and a 3,000-pixel-wide PNG header is refused. The malformed-base64
and plain-reference checks execute the real code mode WASM. A close/reopen is a persistence/replay test, **not** evidence of an
actual platform eviction; the harness runner reports separately when an object
constructor changes. Compaction may legitimately remove an image from active
context while preserving it in historical entries and pre-compaction forks.
The host's object reachability/GC must retain those references.

## Provider URL sources

Current [Anthropic vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision)
accepts base64, URL, and file-id image sources. Current
[OpenAI vision documentation](https://developers.openai.com/api/docs/guides/images-vision)
accepts URL and base64 image inputs in the supported image fields. This is
provider format evidence, not a paid real-model call in this experiment.
The signed route restricts the object namespace, signs the exact key and
expiry, expires within five minutes, and streams private R2 objects. Signed
URLs exist only in outbound requests, not durable history. Retries mint them
again; provider fetches must finish inside their validity period.

A marker is not an authorization grant. Production must resolve it through a
tenant-owned immutable image record and retention lease before signing or
streaming. The authenticated harness uses only its private fixture bucket.
D also restricts keys to its derivative prefix; B/C expose an `allowKey` hook
but do not configure tenant ownership. None implements cross-tenant authorization.
