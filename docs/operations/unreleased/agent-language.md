### Agents have a primary language

`language` sets an agent's primary language as a BCP 47 tag (`"es"`, `"es-ES"`, `"pt-BR"`, `"zh-Hant"`; at most 35
characters, stored in canonical case, junk refused with 400). Give it when you make an agent, on a stateless run, or on
a definition (its agents take it unless they set their own, which applying the definition keeps); change it with
`PATCH /v1/agents/:id/configuration`, where `null` removes it. `GET /v1/agents/:id` and definitions show it. With one
set, the system prompt gets one fixed line after the environment summary, e.g. "Language: reply in Spanish (español) by
default. If the person clearly writes in another language, reply in that language instead." The line is the same every
turn, so prompt caching holds. Compaction summaries are unchanged. The TypeScript and Python SDKs take `language`
(`language=`) on create, configure and runs. Agents without it are unchanged.
