# Files and platform parity

This branch closes the files-platform contract gaps reported for PR #653. The
source runtime remains the specification. No product assertion is relaxed.

## Changes

- File arguments stay off for external tools unless their definition enables
  them. Enabled tools receive mount-authorized bytes or call-bound URLs. URLs
  retain file versions and directory snapshots and carry call identity and expiry.
- MCP and OpenAPI file inputs support their declared transport. Binary, image,
  audio and long text results are retained in the workspace. Download responses
  use the source sandbox headers, and fetched redirects are checked separately.
- REST attachments retain immutable references in history. Provider requests
  apply source image count, byte and dimension limits. A failed resize is retried
  on the next request. PDFs are inspected before native document selection.
- Image generation uses the configured transport and source key, billing and
  admission policy. Volume requests replay their idempotent responses.
- Search and rendering use tenant keys before platform keys, preserve provider
  prices, meter auxiliary usage and recheck credit between calls. Nested
  codemode calls receive structured results and the source error shape.
- Workspace inheritance, schedule email policy, self-hosted errors and browser
  URLs match the source. CLI creation and reconfiguration keep their public
  status and request identifiers.
- Journey event policy is shared with Node through `src/core/journey.ts`.
  Workers supplies database, request lifetime and bound fetch services. Console
  pages serve at the mounted path and add journey metadata only when enabled.

The file-argument schema and resolution policy also move to
`src/core/file-arguments.ts`. Node imports the same implementation. These are
source extractions, not new generated copies.

## Verification

Scoped contract evidence and the remaining failures are recorded below after
the final run. All execution uses the team's Sprites pool with local workerd,
Postgres and scripted providers. There is no cloud deployment or production
database access in this work.

The original Node file-argument and tool-file suites pass 11/11. The original
journey and journey-billing suites pass 41/41. Independent review found the
extracted file-argument runtime declarations unchanged.

## Limits requiring follow-up

PDF inspection currently uses the serverless PDF.js build inside the Worker
with byte limits, disabled eval and disabled font loading. It does not reproduce
the source runtime's externally killable parser process. Selecting an isolated
parser host and validating adversarial CPU and memory behavior remain migration
decisions; passing public file contracts does not resolve them.

The local fake providers verify protocol and accounting behavior. These checks
do not establish live provider acceptance, deployed performance or production
readiness.
