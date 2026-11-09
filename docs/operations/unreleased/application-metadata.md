### Application metadata and GitHub repository access

Agents accept tenant-owned `metadata` on creation and configuration updates.
List and detail responses include it; `?metadata.type=camelcode-project` filters
by top-level string values. The JSON object is limited to 16,384 UTF-8 bytes.
An omitted value preserves existing data; a supplied object replaces it, and
`{}` clears it. Metadata is not sent to the model.

Registered GitHub Apps now support paginated repository listing and repository
access checks using their stored credentials. Responses contain repository
metadata, never private keys or installation tokens. Existing name/type fields,
agent clients, and egress grants continue to work.
