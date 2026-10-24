### Keep recent images within provider limits

Model requests keep the newest 40 images, or 90 for Anthropic models, including
models reached through gateways. Older images are replaced with text in the
outgoing request. Saved history and files are unchanged. The same cap applies
to summary requests, and image token estimates use the capped request.

If a provider still rejects the image count, the runtime retries once without
images for the rest of that turn. These failures are classified as `image_limit`.
