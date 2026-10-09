### generate_image builtin

- Agents, definitions and stateless runs take a `generate_image` builtin: the model makes an image, or edits images
  from its files, with `gpt-image-2.5-flare` (as `POST /v1/images` does). The image is saved to the workspace under
  `tool-outputs/generate_image/`, shown to the model, and presented to the user with `present_file`. A stateless run
  with it gets a workspace. See [Images](../guides/images.md#in-an-agent).
- Its images are billed per token like `POST /v1/images`, with the run's facts on `usage.recorded` (`kind: "image"`),
  and count against the agent's and the run's spend limits (checked against the estimate before anything is sent). A
  run's `usage.imageCostUsd` says what they cost, and a sub-agent's count toward its parent's spend.
- Saving a definition or an agent with `generate_image` and no OpenAI key to use answers with a warning; the console's
  definition editor offers it.
