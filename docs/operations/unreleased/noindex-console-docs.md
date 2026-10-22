### Search engines are asked not to list the console or the docs' Markdown copies

The console and the pages that lead to it (`/`, `/console` and everything under it, its sign-in, billing and Discord
routes, and `/oauth/authorize`) now answer with `X-Robots-Tag: noindex`, and so does every document the runtime
serves for agents: `/llms.txt`, `/llms-full.txt`, `/SKILL.md`, `/docs/**/*.md` and the UI registry's `/r/*.json`.
The runtime also serves a `/robots.txt` that blocks nothing, so crawlers can fetch those pages and see the header.
The documents' bodies, types and caching are unchanged, and so are the API, `/mcp` and the other endpoints.
