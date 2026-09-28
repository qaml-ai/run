# research-agent

The runtime's built-in `web_search` and `web_fetch` tools, given to the agent with `builtins`, answering a question with
cited sources. No tools of your own and nothing to host.

```sh
npm install
export CAMELAI_API_KEY=art_...
npm start -- "What changed in the most recent Node.js LTS release?"
```

```
→ web_search({"query":"site:nodejs.org/en/blog/release most recent Node.js LTS release"})
→ web_fetch({"url":"https://nodejs.org/en/blog/release/v24.21.0"})
The latest Node.js LTS release is 24.21.0 ("Krypton"), released September 8. [1]
…
Sources
[1] https://nodejs.org/en/blog/release/v24.21.0
```

Web searches are billed per search unless you add your own provider key.
