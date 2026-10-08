# Projects: agents that build, apps that publish

An agent builds something in a camelRun **volume** with its own file tools (`write`, `edit`, `grep`…). When it's
ready, it calls the app's **`publish`** tool. The app reads the volume itself, checks the files, and keeps an
**immutable version**, or answers with the problems so the agent can fix them and try again. Visitors only ever see
published versions, which the app serves on its own: camelRun can be down and nothing they see changes.

| Example | The agent builds | `publish` checks | The app shows |
| --- | --- | --- | --- |
| [website](website) | a static site: HTML, CSS, JS under `/site` | an `index.html`, every local link and asset resolves, ≤ 200 files and 5 MB | each version at `/sites/:project/v/:n/` |
| [dashboard](dashboard) | SQL queries and a chart spec under `/dashboard`, over a bundled SQLite dataset | the spec's schema; every query runs (read-only, one statement, ≤ 1,000 rows, ≤ 2 s) and returns the columns its chart draws | the dashboard, its queries run live |

## Quickstart

You need Node 22.13 or newer and a camelRun API key (https://run.camelai.com/console/tokens).

```sh
npm install
export CAMELAI_API_KEY=art_...
npm run website        # or: npm run dashboard
```

The app serves its viewer at http://localhost:3000 and opens a prompt in your terminal, where you talk to the
project's agent:

```
demo> Make a one-page site for a bakery called Crumb, with a menu section, then publish.
→ write /site/index.html
→ write /site/style.css
→ publish
← {"published":true,"version":1,"url":"http://localhost:3000/sites/demo/v/1/"}
Published: http://localhost:3000/sites/demo/v/1/
demo> Make the header green and publish again.
→ edit /site/style.css
→ publish
← {"published":true,"version":2,"url":"http://localhost:3000/sites/demo/v/2/"}
```

Open http://localhost:3000 to see the versions. When `publish` finds problems (a page that links a missing
file, a query naming a column that doesn't exist), the agent gets them as the tool's result, fixes the files and
publishes again:

```
→ publish
← {"published":false,"problems":[{"path":"queries/by_month.sql","message":"no such table: sales"}]}
→ edit /dashboard/queries/by_month.sql
→ publish
← {"published":true,"version":3,"url":"http://localhost:3000/dashboards/demo/v/3"}
```

`npm run website -- shop` works on another project, with its own agent, volume and versions. `npm test` runs the
tests; they need no runtime.

| Variable | |
| --- | --- |
| `CAMELAI_API_KEY` | your API key |
| `CAMELAI_BASE_URL` | a runtime other than https://run.camelai.com, e.g. one you run yourself (`http://127.0.0.1:8790`) |
| `AGENT_MODEL` | a model other than your account's default, e.g. `anthropic/claude-haiku-4-5` |
| `PORT` | the app's port (default 3000) |
| `PUBLIC_URL` | where camelRun reaches this app, to serve the tools over HTTP (see below) |
| `DATA_DIR` | where versions are kept (default `./data`) |

## How it works

[`lib/projects.ts`](lib/projects.ts) is the pattern, shared by both apps:

- **A project is a volume.** `projects.open("demo")` makes the project's volume once (the app remembers which,
  in `data/site-volumes.json`) and upserts its agent, `site-demo`, with the volume mounted read-write at `/site`
  and `context: { project: "demo" }`.
- **`publish` takes no arguments.** It reads the project from the call's identity (`identity.context.project`),
  which the app set with its API key and the model can't change. It never takes a project, a path or file contents
  from the model, so an agent can only ever publish its own project, as it is in its volume.
- **The app reads the volume itself** (`agents.runtime.volume(id).list()` and `.read()`, with its API key),
  hands the files to the example's validator, and on success stores them as the next version.
- **Versions are immutable.** [`lib/versions.ts`](lib/versions.ts) writes each to a scratch directory, then
  renames it into place: a version never changes once it exists, two publishes can't take the same number, and a
  retried call (same idempotency key) gets its version back instead of making another.

The examples differ only in their validator ([website/validate.ts](website/validate.ts),
[dashboard/validate.ts](dashboard/validate.ts)) and their viewer (`app.ts`).

### Tools in this process, or over HTTP

By default `publish` runs in the app's process, attached to each agent: the app needs no public URL, so it runs
from a laptop. Deployed, set `PUBLIC_URL`: the app then serves the same tools at `<PUBLIC_URL>/mcp` with
`serveTools`, and makes its agents from a definition that names that server (`auth: { type: "runtime" }`). Every
call then carries a signed identity token, checked for your tenant, and any number of app instances can answer.
The tool reads `identity` the same way either way; [tests/website.test.ts](tests/website.test.ts) calls it over
HTTP with signed tokens (`testRuntime()`), including another tenant's.

### Safety notes

- A published site is served with `Content-Security-Policy: sandbox`, so its scripts run in an opaque origin and
  can't act as the app.
- Dashboard queries run in a child process over an in-memory copy of the data with `PRAGMA query_only`; one that
  runs past 2 seconds is killed.
- The terminal prompt is the app's operator talking to the agent. A real app puts its own sign-in in front of
  that, and makes each user's projects with `subject` set to the user.
