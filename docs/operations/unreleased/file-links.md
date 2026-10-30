Agents can transfer workspace files through any tool that accepts a URL.
Enable `file_link` to sign a GET or PUT URL (5 minutes by default, at most 15),
and `file_import` to stream a public URL into a writable path without sending
file bytes through the model. PUT requires a size cap; imports allow up to
256 MiB and use the outbound guard and storage quota.

MCP blobs and media over 32 KiB are saved under `/workspace/mcp/<server>/<sha256>`.
Text keeps its existing handling; small images stay inline. Resource links stay
links for `file_import`.

Computer uploads and downloads now use the same signed links, valid for 120
seconds, with size and SHA-256 verification. Links can be reused until expiry;
they replace single-use transfer tokens. Migration 100 drops `computer_transfers`;
migration 099 is unchanged. See `docs/guides/files.md` and `docs/guides/computers.md`.
