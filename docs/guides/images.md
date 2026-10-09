# Images

`POST /v1/images` makes images from a prompt, or edits images you give it, with no agent. An agent makes them with
the `generate_image` builtin.

Images are made with OpenAI's `gpt-image-2.5-flare` and the OpenAI key a model call of yours would use: a
[key scope](models-and-keys.md#key-scopes)'s, your own (`PUT /v1/providers/openai/key`), else the platform's, which a
prepaid account pays for per token, at OpenAI's prices (see [Pricing](../pricing.md)).

## Making an image

```bash
curl -X POST "$RUNTIME/v1/images" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "A watercolor camel crossing dunes at dawn", "size": "1536x1024"}'
```

```json
{
  "images": [{ "contentType": "image/png", "width": 1536, "height": 1024, "data": "iVBORw0KGgo…" }],
  "model": "openai/gpt-image-2.5-flare", "usage": { "inputTokens": 16, "outputTokens": 343 }, "costUsd": 0.01037
}
```

| Field | |
| --- | --- |
| `prompt` | what to make, or how to change the images given (at most 32,000 characters) |
| `size` | `1024x1024` (default), `1536x1024` (landscape) or `1024x1536` (portrait) |
| `quality` | `low`, `medium` (default) or `high` |
| `format` | `png` (default), `jpeg` or `webp` |
| `background` | `transparent` (with `png` or `webp`) or `opaque`; the model chooses when left out |
| `n` | how many images, 1 to 4 (default 1) |
| `keyScope` | a key scope whose OpenAI key goes first |
| `volumeId`, `path` | save the images in a volume of yours instead (below) |
| `subject`, `context`, `actor` | who it is for and who asked, carried to its `usage.recorded` event, as an agent's identity is |

The answer comes when the images are ready: about 10 seconds for one at `low` or `medium`, longer at `high` (OpenAI
allows up to two minutes for a complex prompt). The images come back as base64 and nothing is kept. A retry makes (and
bills) new images; it takes no `Idempotency-Key`. API tokens and OAuth tokens may make images; browser tokens may not.
Runs-per-minute limits count each request as a run.

## Editing images

Give up to 4 images (PNG, JPEG or WebP) in `images`, and the prompt says how to change or combine them:

```bash
curl -X POST "$RUNTIME/v1/images" -H "Authorization: Bearer $TOKEN" -F prompt="Put this camel on a beach" \
  -F image=@camel.png -F quality=high
```

In JSON, each image is `{"data": "<base64>"}` or `{"url": "https://…"}`, which the runtime fetches from the public
internet (three redirects at most). As multipart, each is a file part named `image`, and the fields are form fields
(`context` as JSON). A `mask` (a part, or `{data}`/`{url}`) says where the first image may change: transparent there,
an image with an alpha channel in that image's format and size.

## Saving to a volume

With `volumeId` (one of your [volumes](files.md)), the images are saved there, under `path` (a directory, default
`/images`), and the answer gives their paths instead of their bytes:

```json
{ "images": [{ "contentType": "image/png", "width": 1024, "height": 1024, "volumeId": "vol_…", "path": "/images/image-20261009T104512-3fa9c1.png", "size": 1316554, "version": 1 }], … }
```

Read them with `GET /v1/volumes/{id}/files/{path}`, or hand a browser a signed link to one
(`POST /v1/volumes/{id}/links`). They count toward your storage like any file.

## In an agent

Give an agent (or its definition, or a stateless run) the `generate_image` builtin:

```ts
const agent = await agents.upsert("illustrator", { builtins: ["generate_image"] });
const run = await agent.run("Draw a camel crossing dunes at dawn, as a watercolor, and show it to me");
```

```python
agent = await agents.upsert("illustrator", builtins=["generate_image"])
run = await agent.run("Draw a camel crossing dunes at dawn, as a watercolor, and show it to me")
```

The model calls `generate_image` with a `prompt`, and optionally `images` (paths of images in its files: an
attachment, or one it made before, to edit or combine), `size`, `quality` (`medium` by default), `format` and
`background`. Each call makes one image, saved to the agent's workspace under `tool-outputs/generate_image/<call>/`,
and answers with its path, size and cost; the model is shown the image, so it can check it or describe it, and
presents it to the user with `present_file` (a `file_presented` event with a signed link). A stateless run with
`generate_image` gets a workspace for its images.

Each image is billed as a request to `POST /v1/images` is, with the run's facts on its `usage.recorded` event
(`agentId`, `requestId`, `actor`, the agent's identity and key scope). It counts against the agent's spend limit and the
run's own `spendLimit`: a call whose estimate is more than is left fails before anything is sent, and the model is told
why. The run's `usage.imageCostUsd` says what its images cost. Saving a definition or an agent with `generate_image`
when the account has no OpenAI key to use answers with a warning, and a call then fails with how to add one.

## Safety

OpenAI's safety system checks the prompt, the images given and the image made. A request it refuses is a 400
`IMAGE_REFUSED`, which names the stage (`input`: the prompt or images given; `output`: the image made) and the
categories it gives, never the prompt:

```json
{ "type": "error", "error": "OpenAI's safety system refused this request (violence)", "code": "IMAGE_REFUSED", "stage": "input", "categories": ["violence"] }
```

A refused request is not charged; in an agent, the model is told it was refused and why. Other errors: a request OpenAI cannot take is a 400 with its reason, a provider
failure is a 502 (`IMAGE_FAILED`), and no OpenAI key to use is a 400 (`IMAGE_UNAVAILABLE`).

## Limits

| | |
| --- | --- |
| Prompt | 32,000 characters |
| Images to edit | 4, PNG, JPEG or WebP, 25 MB each, 50 MB in all, at most 8,000 pixels a side |
| Images made | 4 per request |
| Time | 3 minutes for the provider to answer |

An image to edit that is not one of those types is a 415 (`UNSUPPORTED_IMAGE`); one too large is a 413
(`IMAGE_TOO_LARGE`).

## Billing

On the platform's key, images cost what OpenAI charges for `gpt-image-2.5-flare`: $5 per million text tokens in, $8 per
million image tokens in (images given to edit) and $30 per million image tokens out. The tokens are those OpenAI
reports for the request. One image costs:

| Quality | 1024x1024 | 1536x1024 or 1024x1536 |
| --- | --- | --- |
| `low` | $0.0059 (196 tokens) | $0.0047 (158 tokens) |
| `medium` | $0.0132 (439 tokens) | $0.0103 (343 tokens) |
| `high` | $0.0527 (1,756 tokens) | $0.0412 (1,372 tokens) |

plus the prompt (a few hundredths of a cent), and about $0.008 to $0.012 for each image given to edit (1,024 tokens for
a square one, 1,536 for a wide one). A spend limit refuses a request whose estimate (the most it can cost) is more than
is left of it, before anything is sent. On your own key or a key scope's, OpenAI bills you and camelRun charges
nothing. Either way it is recorded:

- in `GET /v1/usage`, a row per day with `kind: "image"` and model `openai/gpt-image-2.5-flare` (`responses` counts images);
- in the hour's ledger entry, as `image` (micro-USD) and `images`;
- as a [`usage.recorded`](webhooks.md) event with `kind: "image"`, `images`, and its tokens (`input`: text and images
  in, `output`: images out). Made alone, it has `agentId: null` and the `subject`, `context` and `actor` you sent. The
  older usage webhook (`/v1/usage-webhook`) carries model responses only.

It counts toward a tenant's monthly cap and prepaid credit, as a model response does.

## Privacy

Prompts and images are never written to the runtime's logs, which carry sizes, quality, tokens and timings. A request
without `volumeId` keeps nothing; with one, the images are kept in your volume until you delete them. OpenAI processes
the prompt and images under its API data policy (not used for training). See
[Account data](../operations/privacy.md#images).
