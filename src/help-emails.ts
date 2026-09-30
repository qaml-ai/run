import { HELP_CATEGORY_LABELS, HELP_IMPACT_DESCRIPTIONS, HELP_IMPACT_LABELS, type HelpCategory, type HelpFailure, type HelpImpact } from "../shared/help-contract.ts";

/**
 * Get Help mail: one message to support alone, with everything we know that helps investigate, and one
 * shared thread (support and the user) with only what the user wrote. Both carry the same reference.
 */

/** What the server observed when the request was first submitted, frozen so a retry sends the same. */
export interface HelpSnapshot {
  submittedAt: number;
  userAgent?: string;
  /** `replyVerified`: the reply address was one of the tenant's verified billing addresses. */
  who: { tenant: string; login?: string; githubId?: number; signIn: "github" | "token"; tenantCreatedAt?: number; replyVerified?: boolean };
  agent?: { found: false } | {
    found: true; id: string; key?: string; name: string; type: string; model: string;
    definition?: { id: string; revision: number }; pendingRuns: boolean; resumeFailures: number; resumeAfter?: number;
  };
  /** A field left out was not read: its part is in `unavailable`. */
  account: {
    billing?: string; balance?: number;
    /** Why new runs are refused now, if they are. */
    runsBlocked?: string;
    autoTopup?: string; agents?: number; keys?: string[]; customProviders?: number; channels?: string[];
  };
  runtime: { host: string; release?: string; node: string; logGroup?: string };
  /** Parts whose lookups failed (tenant, agent, billing, balance, run_limit, auto_topup, agents, keys, custom_providers, channels). */
  unavailable?: string[];
}
/** What the user sent: the form, and the bounded context their console attached. */
export interface HelpMessage {
  reference: string;
  email: string;
  category: HelpCategory;
  impact?: HelpImpact;
  description: string;
  agentId?: string;
  requestId?: string;
  client: { page?: string; viewport?: string; timezone?: string; build?: string; failures: HelpFailure[] };
}
export interface HelpEmail { subject: string; html: string; text: string }

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "'Silkscreen','Courier New',Courier,monospace";
const CODE = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";
const IMPACT_TAG: Record<HelpImpact, string> = { minor: "LOW", degraded: "MED", blocking: "HIGH" };
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dollars = (n: number) => `${n < 0 ? "−" : ""}$${(Math.abs(n) / 1e6).toFixed(2)}`;
/** A header-safe subject: one line, at most `max` characters (the mail Worker takes 256). */
const oneLine = (value: string, max: number) => {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};
/** The description's first line, as the request's subject. */
export const helpSubject = (message: HelpMessage) =>
  oneLine(message.description.split(/\r?\n/).find(line => line.trim()) ?? "", 80) || HELP_CATEGORY_LABELS[message.category];

type Rows = [string, string | undefined][];
const present = (rows: Rows) => rows.filter((row): row is [string, string] => row[1] !== undefined && row[1] !== "");
const textRows = (rows: Rows) => present(rows).map(([label, value]) => `${label}: ${value}`).join("\n");
const htmlRows = (rows: Rows) => present(rows).map(([label, value]) =>
  `<tr><td style="padding:3px 12px 3px 0;color:#8a888f;font-size:13px;width:150px;vertical-align:top">${escape(label)}</td><td style="padding:3px 0;color:#111113;font-size:13px;word-break:break-word">${escape(value)}</td></tr>`).join("");
const section = (title: string, body: string) =>
  `<p style="margin:22px 0 8px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:#8a888f">${escape(title)}</p>${body}`;
const table = (rows: Rows) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;font-family:${FONT}">${htmlRows(rows)}</table>`;
const pre = (text: string) => `<pre style="margin:0;padding:14px;background:#f6f4ee;border:1px solid #d5d2c9;font-family:${CODE};font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;color:#111113">${escape(text)}</pre>`;

function page(title: string, preheader: string, body: string, width: number, origin?: string) {
  const font = origin ? `<style>@font-face{font-family:Silkscreen;src:url('${origin}/console/email/silkscreen.woff2') format('woff2');font-weight:400;font-style:normal}</style>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escape(title)}</title>${font}</head>
<body bgcolor="#f6f4ee" style="margin:0;padding:0;background-color:#f6f4ee">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6f4ee"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${width}px"><tr><td bgcolor="#efede6" style="background-color:#efede6;border:1px solid #d5d2c9;padding:28px;font-family:${FONT};color:#111113;font-size:14px;line-height:22px">
${body}
</td></tr></table></td></tr></table></body></html>`;
}

function clientTime(snapshot: HelpSnapshot, timezone?: string) {
  if (!timezone) return undefined;
  try { return `${new Date(snapshot.submittedAt).toLocaleString("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })} ${timezone}`; }
  catch { return undefined; }
}

const UNAVAILABLE = "unavailable (lookup failed)";
const failed = (snapshot: HelpSnapshot, part: string) => !!snapshot.unavailable?.includes(part);
/** A value support can trust as read, or an explicit unknown when its lookup failed. */
const known = <T>(snapshot: HelpSnapshot, part: string, value: T | undefined, show: (value: T) => string) =>
  failed(snapshot, part) || value === undefined ? UNAVAILABLE : show(value);
const newRuns = (snapshot: HelpSnapshot) => failed(snapshot, "run_limit") ? "unknown (lookup failed)"
  : snapshot.account.runsBlocked ? `blocked: ${snapshot.account.runsBlocked}` : "allowed";

function agentLine(snapshot: HelpSnapshot, message: HelpMessage) {
  const agent = snapshot.agent;
  if (message.agentId && failed(snapshot, "agent")) return `${message.agentId} (lookup failed; supplied by the user)`;
  if (!message.agentId || !agent) return undefined;
  if (!agent.found) return `${message.agentId} (not found in this tenant; supplied by the user)`;
  return [agent.id, agent.key && `key ${agent.key}`, `"${agent.name}"`, `type ${agent.type}`, `model ${agent.model}`,
    agent.definition && `definition ${agent.definition.id}@${agent.definition.revision}`].filter(Boolean).join(" · ");
}
function agentHealth(snapshot: HelpSnapshot) {
  const agent = snapshot.agent;
  if (!agent?.found) return undefined;
  const resume = agent.resumeFailures ? `${agent.resumeFailures} resume failure${agent.resumeFailures === 1 ? "" : "s"}${agent.resumeAfter ? `, next attempt ${iso(agent.resumeAfter)}` : ""}` : "no resume failures";
  return `${agent.pendingRuns ? "runs pending" : "no pending runs"} · ${resume}`;
}
const failureLine = (failure: HelpFailure) => `${failure.at.replace(/\.\d{3}Z$/, "Z")} ${failure.method} ${failure.path} → ${failure.status || "network error"}`;

/** Plain text for pasting to an agent investigating: observed facts apart from what the user supplied. */
export function helpInvestigation(snapshot: HelpSnapshot, message: HelpMessage) {
  const { who, account, runtime } = snapshot;
  const agent = snapshot.agent?.found ? snapshot.agent : undefined;
  const earliest = Math.min(snapshot.submittedAt, ...message.client.failures.map(failure => Date.parse(failure.at)).filter(Number.isFinite));
  const from = iso(Math.min(earliest - 30 * 60_000, snapshot.submittedAt - 2 * 3600_000)), to = iso(snapshot.submittedAt + 10 * 60_000);
  const filters = [`tenant = "${who.tenant}"`, agent && `agent = "${agent.id}"`, message.requestId && `requestId = "${message.requestId}"`].filter(Boolean);
  const supplied = [message.requestId && `request=${message.requestId}`, message.agentId && !agent && `agent_input=${message.agentId}`].filter(Boolean);
  return [
    `camelRun help ${message.reference}, submitted ${iso(snapshot.submittedAt)} on ${runtime.host}${runtime.release ? ` (release ${runtime.release})` : ""}`,
    `Observed: tenant=${who.tenant}${who.login ? ` login=${who.login}` : ""}${agent ? ` agent=${agent.id}` : ""} billing=${account.billing ?? "unknown"}` +
      `${account.balance !== undefined ? ` balance=${dollars(account.balance)}` : failed(snapshot, "balance") ? " balance=unknown" : ""}` +
      ` new_runs=${failed(snapshot, "run_limit") ? "unknown" : account.runsBlocked ? `blocked ("${account.runsBlocked}")` : "allowed"}`,
    ...(snapshot.unavailable?.length ? [`Lookups that failed (unknown, not empty): ${snapshot.unavailable.join(", ")}`] : []),
    ...(agent ? [`Agent state: ${agentHealth(snapshot)}`] : []),
    `Supplied by the user, not verified: ${supplied.length ? supplied.join(" ") : "none"}`,
    `Console-reported failures: ${message.client.failures.length ? message.client.failures.map(failureLine).join("; ") : "none"}`,
    `Logs: CloudWatch Logs Insights on ${runtime.logGroup ?? "the runtime's log group"}, ${from} to ${to}:`,
    `  fields @timestamp, type, tenant, agent, requestId, error`,
    `  | filter ${filters.join(" or ")}`,
    `  | sort @timestamp desc | limit 200`,
  ].join("\n");
}

/** To support only: everything that helps investigate. Replies stay with support. */
export function helpSupportEmail(snapshot: HelpSnapshot, message: HelpMessage): HelpEmail {
  const { who, account, runtime } = snapshot;
  const subject = helpSubject(message);
  const tags = `${message.impact ? `[${IMPACT_TAG[message.impact]}] ` : ""}[${HELP_CATEGORY_LABELS[message.category]}]`;
  const title = oneLine(`${tags} ${subject} · ${who.login ?? who.tenant} · ${message.reference}`, 200);
  const days = who.tenantCreatedAt !== undefined ? Math.floor((snapshot.submittedAt - who.tenantCreatedAt) / 86_400_000) : undefined;
  const whoRows: Rows = [
    ["GitHub", who.login && `${who.login}${who.githubId ? ` (id ${who.githubId})` : ""}`], ["Tenant", who.tenant],
    ["Signed in with", who.signIn === "github" ? "GitHub" : "an operator or API token"],
    ["Tenant created", failed(snapshot, "tenant") ? UNAVAILABLE : who.tenantCreatedAt !== undefined ? `${iso(who.tenantCreatedAt).slice(0, 10)} (${days} day${days === 1 ? "" : "s"} ago)` : undefined],
    ["Reply to", `${message.email} (${who.replyVerified ? "verified billing address on file" : "typed in the form, not verified"})`],
  ];
  const whatRows: Rows = [["Category", HELP_CATEGORY_LABELS[message.category]],
    ["Impact", message.impact && `${HELP_IMPACT_LABELS[message.impact]} (${HELP_IMPACT_DESCRIPTIONS[message.impact]})`], ["Subject", subject]];
  const whereRows: Rows = [["Page", message.client.page], ["Agent", agentLine(snapshot, message)], ["Agent state", agentHealth(snapshot)],
    ["Request", message.requestId && `${message.requestId} (supplied by the user, not verified)`]];
  const accountRows: Rows = [
    ["Billing", known(snapshot, "billing", account.billing, mode => `${mode}${account.balance !== undefined ? ` · balance ${dollars(account.balance)}` : failed(snapshot, "balance") ? " · balance unavailable (lookup failed)" : ""}`)],
    ["New runs", newRuns(snapshot)], ["Auto top-up", known(snapshot, "auto_topup", account.autoTopup, String)],
    ["Agents", known(snapshot, "agents", account.agents, String)], ["Provider keys", known(snapshot, "keys", account.keys, keys => keys.join(", ") || "none")],
    ["Custom providers", known(snapshot, "custom_providers", account.customProviders, String)], ["Channels", known(snapshot, "channels", account.channels, channels => channels.join(", ") || "none")],
  ];
  const clientRows: Rows = [["Submitted", iso(snapshot.submittedAt)], ["User's local time", clientTime(snapshot, message.client.timezone)],
    ["User agent", snapshot.userAgent], ["Viewport", message.client.viewport], ["Console build", message.client.build ?? "unknown"]];
  const runtimeRows: Rows = [["Host", runtime.host], ["Release", runtime.release ?? "unknown"], ["Node", runtime.node]];
  const failures = message.client.failures.map(failureLine);
  const investigation = helpInvestigation(snapshot, message);
  const text = `New camelRun help request ${message.reference}
${message.impact ? `Impact: ${HELP_IMPACT_LABELS[message.impact]} (${HELP_IMPACT_DESCRIPTIONS[message.impact]})\n` : ""}
WHO
${textRows(whoRows)}

WHAT
${textRows(whatRows)}

DESCRIPTION
${message.description}

WHERE (observed on the server)
${textRows(whereRows)}

ACCOUNT
${textRows(accountRows)}

CLIENT (reported by the browser)
${textRows(clientRows)}
Recent console API failures:${failures.length ? `\n${failures.map(line => `  ${line}`).join("\n")}` : " none"}

RUNTIME
${textRows(runtimeRows)}

INVESTIGATE (paste to Claude or Astra)
${investigation}
`;
  const html = page(title, `${HELP_CATEGORY_LABELS[message.category]} from ${who.login ?? who.tenant}: ${subject}`, `
<p style="margin:0 0 6px;font-family:${MONO};font-size:10px;letter-spacing:3px;color:#8a888f">CAMELRUN · SUPPORT · INTERNAL</p>
<h1 style="margin:0 0 4px;font-size:18px;line-height:26px;font-weight:600">New help request ${escape(message.reference)}</h1>
${message.impact ? `<p style="margin:0;font-size:14px;color:${message.impact === "blocking" ? "#b8281b" : "#3f3f45"}">Impact: ${escape(HELP_IMPACT_LABELS[message.impact])}, ${escape(HELP_IMPACT_DESCRIPTIONS[message.impact].toLowerCase())}</p>` : ""}
${section("WHO", table(whoRows))}
${section("WHAT", table(whatRows))}
${section("DESCRIPTION", `<div style="padding:14px;background:#f6f4ee;border:1px solid #d5d2c9;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px">${escape(message.description)}</div>`)}
${section("WHERE · OBSERVED ON THE SERVER", table(whereRows))}
${section("ACCOUNT", table(accountRows))}
${section("CLIENT · REPORTED BY THE BROWSER", table(clientRows) + (failures.length ? pre(failures.join("\n")) : `<p style="margin:4px 0 0;font-size:13px;color:#8a888f">No recent console API failures.</p>`))}
${section("RUNTIME", table(runtimeRows))}
${section("INVESTIGATE · PASTE TO CLAUDE OR ASTRA", pre(investigation))}`, 640);
  return { subject: title, html, text };
}

/** To support, with the user copied: only what the user wrote, so anyone on support can reply in the thread. */
export function helpThreadEmail(message: HelpMessage, origin: string): HelpEmail {
  const subject = helpSubject(message);
  const title = oneLine(`We got your request: ${subject} · ${message.reference}`, 200);
  const quote = message.description.trim().length > 500 ? `${message.description.trim().slice(0, 499).trimEnd()}…` : message.description.trim();
  const rows: Rows = [["Reference", message.reference], ["Category", HELP_CATEGORY_LABELS[message.category]],
    ["Impact", message.impact && HELP_IMPACT_LABELS[message.impact]], ["Agent", message.agentId], ["Request", message.requestId]];
  const next = "Our support team will reply in this thread. Reply to add details, screenshots or logs.";
  const text = `Hi,

We got your camelRun help request.

${textRows(rows)}

"${quote}"

${next}

camelRun support`;
  const base = new URL(origin).origin, logo = `${base}/console/email/logo.png`;
  const html = page(title, "We got your help request.", `
<img src="${escape(logo)}" width="133" height="32" alt="camelAI" style="display:block;border:0;width:133px;height:32px;margin:0 0 20px">
<p style="margin:0 0 14px;font-family:${MONO};font-size:10px;letter-spacing:3px;color:#8a888f">CAMELRUN · SUPPORT</p>
<h1 style="margin:0 0 12px;font-size:20px;line-height:28px;font-weight:600">We got your request</h1>
<p style="margin:0 0 18px;color:#3f3f45">Here's what you sent us.</p>
<div style="padding:16px;background:#f6f4ee;border:1px solid #d5d2c9;margin:0 0 18px">${table(rows)}
<p style="margin:12px 0 0;padding-top:12px;border-top:1px dashed #d5d2c9;font-style:italic;color:#3f3f45;white-space:pre-wrap;word-break:break-word">&quot;${escape(quote)}&quot;</p></div>
<p style="margin:0;color:#3f3f45">${escape(next)}</p>
<p style="margin:18px 0 0;color:#8a888f;font-size:13px">camelRun support</p>`, 480, base);
  return { subject: title, html, text };
}
