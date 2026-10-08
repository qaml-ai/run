import { join } from "node:path";
import { Hono } from "hono";
import { Agents } from "@camelai/run";
import { BASE_URL, DATA_DIR, PUBLIC_URL, html, page, start } from "../lib/app.ts";
import { Projects } from "../lib/projects.ts";
import { Versions } from "../lib/versions.ts";
import { validateSite } from "./validate.ts";

const versions = new Versions(join(DATA_DIR, "sites"));
const projects = new Projects({
  agents: new Agents(),
  kind: "site",
  dataDir: DATA_DIR,
  versions,
  validate: validateSite,
  url: (project, version) => `${BASE_URL}/sites/${project}/v/${version}/`,
  publicUrl: PUBLIC_URL,
  agent: {
    ...(process.env.AGENT_MODEL ? { model: process.env.AGENT_MODEL } : {}),
    instructions: `You build a static website (HTML, CSS, JavaScript) with the user. Its files are under /site, with
/site/index.html as the home page. Use relative links between pages and assets. Keep the site small: write the
files, edit them in place when asked for changes, and don't rewrite what you don't need to.
When a change is ready, call publish. It either publishes a new version and gives you its address, which you share,
or lists problems: fix every one and publish again. Never claim a version is live unless publish said so.`,
  },
});

const app = new Hono();
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", txt: "text/plain; charset=utf-8",
};

app.get("/", c => c.redirect(`/sites/${PROJECT}`));

// The viewer: a project's published versions, the latest one open.
app.get("/sites/:project", async c => {
  const project = c.req.param("project");
  const list = (await versions.list(project)).reverse();
  const rows = list.map(v => `<tr><td><a href="/sites/${project}/v/${v.number}/" target="site">v${v.number}</a></td>
    <td class="muted">${html(new Date(v.publishedAt).toLocaleString())}</td><td class="muted">${v.files} files, ${(v.bytes / 1024).toFixed(1)} KB</td></tr>`);
  return c.html(page(`${project}: published versions`, list.length
    ? `<h1>${html(project)}</h1><table>${rows.join("")}</table><p></p><iframe name="site" src="/sites/${project}/v/${list[0].number}/"></iframe>`
    : `<h1>${html(project)}</h1><p class="muted">Nothing published yet: ask the agent for a site.</p>`));
});

// A published version, exactly as it was published. Sandboxed, so a site's scripts can't act as this app.
app.get("/sites/:project/v/:version/*", async c => {
  const { project, version } = c.req.param();
  let path = decodeURIComponent(c.req.path.slice(`/sites/${project}/v/${version}/`.length));
  if (path === "" || path.endsWith("/")) path += "index.html";
  const data = await versions.file(project, Number(version), path);
  if (!data) return c.text("Not found", 404);
  return c.body(data, 200, {
    "Content-Type": TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream",
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});
app.get("/sites/:project/v/:version", c => c.redirect(`${c.req.path}/`));

const PROJECT = process.argv[2] ?? "demo";
await start(app, projects, PROJECT);
