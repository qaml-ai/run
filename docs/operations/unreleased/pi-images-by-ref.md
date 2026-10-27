### Inline images kept as files for AGENT_PI_IMAGE_REFS_TENANTS

For tenants in `AGENT_PI_IMAGE_REFS_TENANTS`, inline images in prompts and tool results
(application tools, MCP images that were not saved) are written to the agent's
workspace as `attachments/<sha256>.<ext>`, and the journal keeps a file reference
instead of base64. Requests load the file, so the model sees the same image after
one line naming it. Pi's context and the history API hold a reference of a few
hundred bytes instead of up to 5 MB per image. The storage limit does not refuse
these writes. Agents without a writable mount keep images inline. With the flag
off, nothing changes.
