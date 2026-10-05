/** The docs site people read (run.camelai.com/docs/*.md is the same text as Markdown, for coding agents). */
export const DOCS = "https://camelai.com/docs/camelrun";

export type DocsPage =
  | "overview" | "quickstart" | "concepts" | "tools" | "definitions" | "channels" | "files" | "models-and-keys" | "authentication"
  | "pricing" | "observability" | "export" | "events" | "production" | "mcp-server" | "limits";

export const docsUrl = (page: DocsPage) => `${DOCS}/${page}`;
