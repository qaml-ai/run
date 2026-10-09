### Images

- `POST /v1/images` makes images from a prompt, or edits up to 4 images given (base64, URL or multipart, with an
  optional mask), with OpenAI's `gpt-image-2.5-flare` on the OpenAI key a model call would use (a key scope's, the
  tenant's own, else the platform's). It takes `size` (`1024x1024`, `1536x1024`, `1024x1536`), `quality` (`low`,
  `medium` by default, `high`), `format`, `background` and `n` (1 to 4), and answers the images as base64, or, with
  `volumeId`, saves them in that volume and answers their paths. See [Images](../guides/images.md).
- On the platform's key it is billed per token at OpenAI's prices ($5 per million text tokens in, $8 per million image
  tokens in, $30 per million image tokens out: a 1024x1024 image is $0.0059 at `low`, $0.0132 at `medium`, $0.0527 at
  `high`), with spend limits checked against its estimate first. Usage kind `image`: a `GET /v1/usage` row, `image`
  and `images` on the hour's ledger entry, and `usage.recorded` events with `kind: "image"` and `images`. Operators
  set the prices with `AGENT_PRICE_IMAGE_TEXT_INPUT_USD`, `AGENT_PRICE_IMAGE_INPUT_USD` and
  `AGENT_PRICE_IMAGE_OUTPUT_USD` (per million tokens).
- OpenAI's safety refusals are 400 `IMAGE_REFUSED`, with the `stage` and `categories` it names, and are not charged.
  New codes: `IMAGE_UNAVAILABLE`, `IMAGE_REFUSED`, `IMAGE_TOO_LARGE`, `UNSUPPORTED_IMAGE`, `IMAGE_FAILED`.
- `usage.recorded` consumers that map kinds should map `image`; as before, treat a kind you do not know as other usage.
