### Images in the SDKs

- TypeScript: `agents.images.generate(prompt, options?)` and `agents.images.edit(prompt, images, options?)` (also
  `runtime.images`), with the `ImageOptions`, `ImagesResult` and `GeneratedImage` types; `Builtin` includes
  `generate_image`, `RunUsage` has `imageCostUsd`, and `usage.recorded` events type `kind: "image"` and `images`.
- Python: `agents.images.generate(prompt, ...)` and `agents.images.edit(prompt, images, ...)` (also `runtime.images`,
  and the synchronous clients'), images given as bytes, local paths or `{"url"}`. See
  [SDK reference](../reference/sdk.md#images).
- The CLI's MCP tools take `generate_image` among an agent's builtins.
