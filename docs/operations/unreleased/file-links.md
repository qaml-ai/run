### Moving files with any tool that takes a URL

Enable `file_link` to sign a GET or PUT URL for one workspace file (5 minutes by default, at most 15), and hand it to
any tool, such as a shell on a machine behind your own MCP server. `file_import` streams a public URL into a writable
path. Neither sends file bytes through the model. A PUT needs a size cap; imports allow up to 256 MiB and use the
outbound guard and the storage quota.

Files returned by tools an application attaches are now saved to the workspace, as an MCP server's already are. A
resource link from a server without `fileArguments` stays a link, with a hint to use `file_import`.

`computer_upload` and `computer_download` now use the same signed links, valid for 120 seconds, with size and SHA-256
verification. A link can be reused until it expires. Migration 100 drops `computer_transfers`. See
`docs/guides/files.md` and `docs/guides/computers.md`.
