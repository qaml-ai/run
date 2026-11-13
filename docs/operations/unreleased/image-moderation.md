### Image moderation

`POST /v1/moderations/images` accepts one JPEG/PNG up to 2 MiB using an existing API token. It returns OpenAI moderation signals, including applied input types, and errors when the provider cannot complete the check. It uses the platform OpenAI key, no model-run credits, and a shared 120-per-minute tenant limit. The provider deadline is four seconds. Unsupported image categories, including `sexual/minors`, must not be interpreted as successful safety checks. See `docs/guides/images.md`.
