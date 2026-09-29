/**
 * The documentation for tools and agents that read it (https://llmstxt.org): `docs/llms.txt` lists every
 * user-facing page with a link to its Markdown, as the runtime serves it under /docs/, and
 * `docs/llms-full.txt` has them all in one file. `npm run docs` writes both; tests/docs.test.ts checks
 * they are current and that every relative link in the docs resolves.
 */
import { readFileSync, writeFileSync } from "node:fs";

export const DOCS_URL = "https://agents.camelai.dev/docs";

/** The user-facing pages, in reading order, each with what it is for. Operations pages are left out. */
export const PAGES: { section: string; path: string; about: string }[] = [
  { section: "Start", path: "quickstart.md", about: "a working agent in five minutes, in TypeScript, Python or curl" },
  { section: "Start", path: "concepts.md", about: "durable keyed agents, runs, events, where tools run, processes, people in the loop, idempotency" },
  { section: "Guides", path: "guides/tools.md", about: "writing tools; attached and served tools; identity tokens; MCP, OpenAPI and built-in sources" },
  { section: "Guides", path: "guides/human-input.md", about: "approvals, questions and forms; answering them and resuming the run" },
  { section: "Guides", path: "guides/browser.md", about: "browser tokens and the watcher: showing an agent live in a web page" },
  { section: "Guides", path: "guides/files.md", about: "attachments, what the model sees, files out, volumes, signed links" },
  { section: "Guides", path: "guides/multi-user.md", about: "an agent per user or conversation, identity, spend limits and keys per customer" },
  { section: "Guides", path: "guides/webhooks.md", about: "run and input events, signatures, delivery" },
  { section: "Guides", path: "guides/models-and-keys.md", about: "the model catalog, your own keys and endpoints, key scopes, model headers, spend limits" },
  { section: "Guides", path: "guides/custom-models.md", about: "any server that speaks OpenAI's or Anthropic's APIs as a provider of your own or of a key scope: hosted APIs, gateways, vLLM, Ollama" },
  { section: "Guides", path: "guides/definitions.md", about: "reusable configurations, and rolling changes out to their agents" },
  { section: "Guides", path: "guides/channels.md", about: "Slack, Telegram, Discord, GitHub, email and any service that sends webhooks" },
  { section: "Guides", path: "production.md", about: "the checklist before shipping" },
  { section: "Reference", path: "reference/sdk.md", about: "the TypeScript and Python SDKs" },
  { section: "Reference", path: "reference/events.md", about: "every event on an agent's stream, and a run's outcome" },
  { section: "Reference", path: "reference/limits.md", about: "every limit, with its value" },
  { section: "Reference", path: "reference/errors.md", about: "HTTP errors, run failures and tool errors, and what to do about each" },
];

const docs = new URL("../docs/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, docs), "utf8");
const title = (path: string) => /^# (.+)$/m.exec(read(path))?.[1] ?? path;

export function llmsTxt() {
  const sections = [...new Set(PAGES.map(page => page.section))];
  return [
    "# camelAI agent runtime",
    "",
    "> A hosted runtime for durable agents. You define tools in your code (TypeScript or Python SDK, or an HTTP server of",
    "> yours); the runtime runs the model loop, keeps each agent's history and files, runs model-written code in a sandbox,",
    "> and wakes agents when there is work. REST API at https://agents.camelai.dev/v1 (OpenAPI: https://agents.camelai.dev/v1/openapi.json).",
    "",
    "Agents are upserted by a key of yours and run with `agent.run(text)`, which resolves with the run (status, text, inputs,",
    "error). Install `@camelai/agent-runtime` (npm) or `camelai-agent-runtime` (PyPI), and set CAMELAI_API_KEY.",
    "",
    ...sections.flatMap(section => [
      `## ${section}`, "",
      ...PAGES.filter(page => page.section === section).map(page => `- [${title(page.path)}](${DOCS_URL}/${page.path}): ${page.about}`),
      "",
    ]),
    "## Optional", "",
    `- [Full documentation](${new URL("/llms-full.txt", DOCS_URL)}): every page above in one file`,
    "",
  ].join("\n");
}

export function llmsFullTxt() {
  return PAGES.map(page => `<!-- ${DOCS_URL}/${page.path} -->\n\n${read(page.path).trim()}\n`).join("\n---\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(new URL("llms.txt", docs), llmsTxt());
  writeFileSync(new URL("llms-full.txt", docs), llmsFullTxt());
}
