// Renders the proposed sidebar into <aside id="side">. Body data attributes pick the state:
// data-ws (workspace name, or "All workspaces"), data-active (nav id), data-menu ("open" shows the switcher's menu).
const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  agents: '<rect x="4" y="8" width="16" height="12"/><path d="M12 8V4M8 14h.01M16 14h.01"/>',
  definitions: '<path d="M8 3H6v18h2M16 3h2v18h-2"/>',
  usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  wsettings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><rect x="14" y="4" width="4" height="4"/><rect x="8" y="10" width="4" height="4"/>',
  channels: '<path d="M21 12a8 8 0 0 1-12 7l-5 1 1-5a8 8 0 1 1 16-3z"/>',
  volumes: '<path d="M3 7h18v12H3zM3 7l2-3h14l2 3"/>',
  keys: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  models: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/>',
  billing: '<rect x="2" y="5" width="20" height="14"/><path d="M2 10h20"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  docs: '<path d="M4 4h7v16H4zM13 4h7v16h-7"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3 2.5c-.5.2-.5.8-.5 1.5M12 17h.01"/>',
};
ICONS.workspaces = ICONS.wsettings;
const svg = name => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
const WS = { "Support bot": "#3f3f45", "Research": "#8a888f", "All workspaces": null };
const body = document.body, ws = body.dataset.ws, active = body.dataset.active;
const item = (id, label, count) => `<a class="item ${active === id ? "on" : ""}" href="${({ overview: "02-overview.html", agents: "03-agents.html", usage: "04-usage.html", wsettings: "05-workspace-settings.html", workspaces: "01-shell.html" })[id] ?? "#"}">${svg(id)}${label}${count ? `<span class="count">${count}</span>` : ""}</a>`;
const scoped = ws === "All workspaces" ? "All workspaces" : ws;
document.getElementById("side").innerHTML = `
  <div class="brand"><span class="logo"></span>camelRun</div>
  <div class="switcher" title="Switch workspace (⌘K)">
    <span class="swatch ${WS[ws] === null ? "all" : ""}"></span>
    <span><span class="label pixel">Workspace</span><span class="name">${ws}</span></span>
    <span class="chev">⌄</span>
  </div>
  <nav class="side" aria-label="Workspace">
    ${item("overview", "Overview")}
    ${item("agents", "Agents", ws === "Support bot" ? "2" : "6")}
    ${item("definitions", "Definitions")}
    ${item("usage", "Usage")}
    ${ws === "All workspaces" ? item("workspaces", "Workspaces") : item("wsettings", "Workspace settings")}
  </nav>
  <div class="group-label pixel" style="padding-left:22px">Account</div>
  <nav class="side" aria-label="Account">
    ${item("channels", "Channels")}
    ${item("volumes", "Volumes")}
    ${item("keys", "API keys")}
    ${item("models", "Models &amp; keys")}
    ${item("billing", "Billing")}
    ${item("settings", "Settings")}
  </nav>
  <div class="sep"></div>
  <nav class="side">${item("docs", "Docs ↗")}${item("help", "Get help")}</nav>
  <div class="foot">
    <div class="balance"><div class="muted" style="font-size:12px">Balance</div><div class="v"><span class="dot"></span>$48.12</div></div>
    <div class="who"><div class="avatar">M</div><div><div style="font-weight:500">Miguel</div><div class="muted" style="font-size:12px">acme-labs</div></div></div>
  </div>
  ${body.dataset.menu === "open" ? `<div class="menu">
    <div class="sec pixel">Switch workspace</div>
    <div class="row ${ws === "All workspaces" ? "on" : ""}"><span class="swatch all"></span>All workspaces<span class="r">$93.45</span></div>
    <div class="row ${ws === "Support bot" ? "on" : ""}"><span class="swatch"></span>Support bot<span class="r">$51.40</span></div>
    <div class="row"><span class="swatch" style="background:#8a888f"></span>Research<span class="r">$28.03</span></div>
    <div class="row"><span class="swatch all" style="border-style:solid"></span>Unassigned<span class="r">$14.02</span></div>
    <div class="sep" style="margin:6px 0"></div>
    <div class="row muted">Archived (1)</div>
    <div class="row">＋ New workspace</div>
    <div class="row muted">Manage workspaces<span class="r"><span class="kbd">⌘K</span></span></div>
  </div>` : ""}`;
