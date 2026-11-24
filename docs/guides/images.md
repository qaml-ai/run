# Images

`POST /v1/images` makes images from a prompt, or edits images you give it, with no agent. An agent makes them with
the `generate_image` builtin.

Images are made with OpenAI's `gpt-image-2.5-flare` and the OpenAI key a model call of yours would use: a
[key scope](models-and-keys.md#key-scopes)'s, your own (`PUT /v1/providers/openai/key`), else the platform's, which a
prepaid account pays for per token, at OpenAI's prices (see [Pricing](../pricing.md)).

## Making an image

```ts
const { images: [image], costUsd } = await agents.images.generate("A watercolor camel crossing dunes at dawn", { size: "1536x1024" });
await writeFile("camel.png", Buffer.from(image.data!, "base64"));
```

```python
result = await agents.images.generate("A watercolor camel crossing dunes at dawn", size="1536x1024")
Path("camel.png").write_bytes(base64.b64decode(result["images"][0]["data"]))
```

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

```ts
const { images } = await agents.images.edit("Put this camel on a beach", [await readFile("camel.png")], { quality: "high" });
```

```python
result = await agents.images.edit("Put this camel on a beach", [Path("camel.png")], quality="high")
```

```bash
curl -X POST "$RUNTIME/v1/images" -H "Authorization: Bearer $TOKEN" -F prompt="Put this camel on a beach" \
  -F image=@camel.png -F quality=high
```

In JSON, each image is `{"data": "<base64>"}` or `{"url": "https://…"}`, which the runtime fetches from the public
internet (three redirects at most). As multipart, each is a file part named `image`, and the fields are form fields
(`context` as JSON). A `mask` (a part, or `{data}`/`{url}`) says where the first image may change: transparent there,
an image with an alpha channel in that image's format and size.

## Rendering SVG cards in v2

Send an SVG to `POST /v2/images/render` to get PNG bytes in base64. Use the SVG's `width`/`height` or `viewBox` to size the output.
Point `<image href="photo.png">` at an entry in `files`. Each entry is either an `img_...` media ID belonging to your tenant
(uploaded once via `POST /v2/media` or created by `POST /v2/images`) or inline `{ data: "<base64>" }`.

```ts
const card = await client.images.render(
  '<svg width="440" height="80"><textbox x="16" y="10" width="408" height="60" ' +
  'font-family="Sans" font-size="32" font-weight="bold">Maria da Conceição</textbox></svg>',
);
await writeFile("card.png", Buffer.from(card.data, "base64"));
```

### Upload-once media (`POST /v2/media` & `DELETE /v2/media/:id`)

To avoid resending static template images with every render, upload them once:

- `POST /v2/media`: accepts either raw image bytes (`Content-Type: image/png`, `image/jpeg`, `image/webp`, or `image/gif`) or JSON `{ "data": "<base64>", "contentType"?: "..." }`. WebP and GIF (first frame) are automatically converted to PNG. Returns `{ id, url, expiresAt, contentType, width, height, sizeBytes }` where `url` is a short-lived (1-hour) HMAC-signed link (`/v2/images/:id?exp=...&sig=...`). Pass `id` (`img_...`) directly in `files` on `POST /v2/images/render`. Reading uploaded media via `GET /v2/images/:id` or `GET /v2/media/:id` requires either the owning tenant's bearer token or a valid signed URL and is served with `Cache-Control: private` (unauthenticated requests return `401`, cross-tenant requests return `404`).
- `DELETE /v2/media/:id`: deletes a tenant-owned media object and returns `{ ok: true, id, deleted: true }`.
- `POST /v2/moderations/images`: accepts raw `image/jpeg` or `image/png` up to 5 MiB, runs OpenAI `omni-moderation-latest` fail-closed, and returns `{ id, model, flagged, categories, category_scores, category_applied_input_types }`.

### `<textbox>` layout, inheritance, and attributes

A `<textbox>` expands to plain `<text>` / `<tspan>` before rendering:

- **Layout rules**: starts at `font-size` (default `16`) and shrinks toward `min-font-size` (default `60%` of `font-size`) on a single line. If it still does not fit, it wraps at spaces and after `-`, `/`, and `,`, choosing the largest size that fits within `height`. If a single word is wider than `width` at `min-font-size`, it shrinks down to `8 px` and splits at grapheme boundaries only below that floor. Characters are never truncated or ellipsized; if the box is still too small, rendering returns `400` naming the textbox position, dimensions, and a text preview.
- **Alignment & vertical centering**: `align="start|middle|end"` (default `start`), `valign="top|middle|bottom"` (default `middle`), `line-height` (default `1.2`). Vertical alignment uses consistent font ascent/descent metrics (clamped so glyphs never overflow the box), keeping baselines aligned across a row of fields regardless of accents or descenders.
- **Inherited styles**: `<textbox>` inherits `font-family`, `font-weight`, `font-style`, `letter-spacing`, and `fill` from ancestor `<svg>`/`<g>` attributes, inline `style="..."`, and simple `<style>` CSS rules (including `font:` shorthand). Resolved layout properties (`font-size`, `font-family`, `font-weight`, `font-style`, `letter-spacing`, `text-anchor:start`) are emitted explicitly and locked in inline `style="..."` on the generated `<text>` so parent `text-anchor` or stylesheet rules like `text { font-size: 40px }` cannot break the measured layout.
- **Visual pass-through attributes**: `id`, `class`, `stroke`, `stroke-width`, `stroke-linejoin`, `stroke-linecap`, `stroke-miterlimit`, `stroke-dasharray`, `stroke-dashoffset`, `opacity`, `fill-opacity`, `stroke-opacity`, `transform`, `filter`, `text-decoration`, `paint-order`, `clip-path`, `mask`, `visibility`, `word-spacing`, `writing-mode`, plus non-layout declarations from `style="..."` are forwarded to the generated `<text>`.

### Bundled fonts and script coverage

| Alias | Resolved Family | Bundled Styles |
| --- | --- | --- |
| `Sans` (default) | `Noto Sans` | Regular, Bold, Italic, Bold Italic |
| `Serif` | `Noto Serif` | Regular, Bold, Italic |
| `Mono` | `Noto Sans Mono` | Regular, Bold |

Aliases work in `font-family` attributes, CSS `font-family:` lists, CSS `font:` shorthand, and `<style>` blocks. Fallback fonts loaded automatically across all styles: `Noto Sans Math`, `Noto Sans Symbols`, `Noto Sans Symbols 2` (covers `★ ☆ ♡ ♛ ✓ ✗ ✿ ❀` and enclosed alphanumerics), and monochrome `Noto Emoji`.

- **Covered scripts**: Latin (extended/diacritics), Greek, Cyrillic, Arabic, Devanagari, Hebrew, Thai, Hiragana/Katakana, Georgian, Discord decorated name glyphs (`꧁ ꧂ ツ 彡 乂 ღ ꒰ ꒱ 𓆩 𓆪 ｡ ㅤ ༄`), Mathematical Alphanumerics (`𝑱𝒐𝒌𝒆𝒓`), Enclosed Alphanumerics (`Ⓡⓘⓣⓐ`), Symbols/dingbats, monochrome Emoji, and on-demand CJK Unified Ideographs & Hangul (`Noto Sans SC` / `Noto Sans KR`, fetched and cached only when present in the SVG).
- **Unsupported scripts**: characters not covered by any bundled or loaded script font are normalized via Unicode NFKC (so e.g. `Ｗｉｄｅ` renders as `Wide`) or substituted with `?` so trailing symbols and emoji on the same line continue to render cleanly.

### Limits and usage

| Limit | Value |
| --- | --- |
| SVG source size | 1 MiB (`1,048,576` bytes), max 10,000 elements |
| Output dimensions | Up to `4,194,304` pixels (e.g. `2048×2048`), max `4096 px` on either side |
| Input raster images | Up to `16` images, `10 MiB` each, `4096×4096 px` max side, `14 MiB` total base64, `4 MP` decoded total |
| Input raster formats | PNG, JPEG, WebP, and GIF (WebP and GIF first frame auto-converted to PNG) |
| `<textbox>` measurement budget | `4,000` measurements per render |
| Request body | `16 MiB` max |

Each render records a zero-cost usage row (`model: "resvg"`, count and elapsed `vmMs`) in `GET /v2/billing`.

### Agent builtins (`render_image` & `view_image`)

In v2, enable the `images` builtin suite to let an agent call `render_image` (`{ svg, files?: Record<string, repoPath>, path }`).
It reads referenced repo images (auto-converting WebP/GIF to PNG), renders and writes the PNG to `path`, and returns the PNG
as an image content block so the model can inspect its own output. The `files` suite's `view_image` tool lets the model
inspect an existing PNG, JPEG, GIF, or WebP in its repository.

## Saving images to files

On Workers, send a `repo` ID and optional directory `path` (default `images`).
The response includes `repo`, `path`, `size`, and the repo commit `version`.
Read the file with `GET /v1/repos/{id}/files/{path}` or sign a link with
`POST /v1/repos/{id}/links`. Workers returns 400 for `volumeId`.

On the Node runtime, with `volumeId` (one of your [volumes](files.md)), the images are saved there, under `path` (a directory, default
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
