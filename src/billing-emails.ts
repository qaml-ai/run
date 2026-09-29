/** Table-based transactional mail, using camelStream's palette and layout. */
export interface BillingEmail { subject: string; html: string; text: string }
export interface BillingEmailInput {
  kind: "confirmation" | "low" | "depleted";
  tenant: string;
  email: string;
  origin: string;
  token?: string;
  balance?: number;
  threshold?: number;
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const dollars = (n: number) => `${n < 0 ? "−" : ""}$${(Math.abs(n) / 1e6).toFixed(2)}`;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "'Silkscreen','Courier New',Courier,monospace";
export function billingEmail(input: BillingEmailInput): BillingEmail {
  const origin = new URL(input.origin).origin;
  const confirmation = input.kind === "confirmation";
  const depleted = input.kind === "depleted";
  const billing = `${origin}/console/billing`;
  const link = confirmation ? `${origin}/console/billing/confirm#${encodeURIComponent(input.token!)}` : billing;
  const balance = dollars(input.balance ?? 0);
  const subject = confirmation ? "Confirm your email for camelRun billing alerts"
    : depleted ? "You're out of camelRun credit" : `Your camelRun balance is low: ${balance}`;
  const heading = confirmation ? "Confirm billing alerts" : depleted ? "You're out of credit" : "Your balance is running low";
  const sentence = confirmation ? `Confirm that ${input.email} should receive billing alerts for ${input.tenant}.`
    : depleted ? `Add credit to ${input.tenant} to resume new runs.` : `Add credit to ${input.tenant} to keep your agents running.`;
  const cta = confirmation ? "Confirm email" : "Add credit";
  const note = confirmation ? "This link expires in 24 hours. Opening it does not confirm your email." : "";
  const details: [string, string][] = confirmation ? [] : [["Account", input.tenant], ["Balance", balance],
    depleted ? ["New runs", "Paused"] : ["Alert below", dollars(input.threshold ?? 2e6)]];
  const footer = confirmation ? `Someone added this address to the billing alerts for ${input.tenant}. If this wasn't you, ignore this email and nothing else is sent.`
    : `You're receiving this because ${input.email} gets ${depleted ? "out-of-credit" : "low-balance"} alerts for ${input.tenant}.`;
  const e = escape;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><meta name="x-apple-disable-message-reformatting"><title>${e(subject)}</title>
<style>@font-face{font-family:Silkscreen;src:url('${origin}/console/email/silkscreen.woff2') format('woff2');font-weight:400;font-style:normal}</style></head>
<body bgcolor="#f6f4ee" style="margin:0;padding:0;background-color:#f6f4ee">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${e(sentence)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6f4ee"><tr><td align="center" style="padding:40px 16px">
<!--[if mso]><table role="presentation" width="440" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:440px"><tr><td align="center" style="padding:0 0 28px"><img src="${origin}/console/email/logo.png" width="133" height="32" alt="camelAI" style="display:block;border:0;width:133px;height:32px"></td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#efede6" style="background-color:#efede6;border:1px solid #d5d2c9;border-collapse:separate;border-spacing:0">
<tr><td><img src="${origin}/console/email/billing-banner.gif" width="440" height="120" alt="Durable agents. Hosted." style="display:block;border:0;width:100%;height:auto"></td></tr>
<tr><td style="padding:28px 28px 32px"><p style="margin:0 0 14px;font-family:${MONO};font-size:10px;line-height:18px;letter-spacing:3px;color:#8a888f">CAMELRUN · BILLING</p>
${depleted ? `<p style="margin:0 0 14px"><span style="padding:4px 7px;background:#f7ded7;color:#b8281b;font-family:${MONO};font-size:10px;letter-spacing:1px">ACTION NEEDED</span></p>` : ""}
<h1 style="margin:0 0 12px;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:#111113">${e(heading)}</h1>
<p style="margin:0 0 24px;font-family:${FONT};font-size:14px;line-height:22px;color:#3f3f45">${e(sentence)}</p>
${details.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6f4ee" style="border:1px solid #d5d2c9;margin:0 0 24px">${details.map(([label, value], i) => `<tr><td style="padding:10px 12px;${i ? "border-top:1px solid #d5d2c9;" : ""}font-family:${FONT};font-size:13px;color:#8a888f">${e(label)}</td><td align="right" style="padding:10px 12px;${i ? "border-top:1px solid #d5d2c9;" : ""}font-family:'Courier New',monospace;font-size:13px;word-break:break-word;color:#111113">${e(value)}</td></tr>`).join("")}</table>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#111113" style="mso-padding-alt:13px 28px"><a href="${e(link)}" style="display:inline-block;padding:13px 28px;font-family:${MONO};font-size:11px;line-height:18px;letter-spacing:3px;text-transform:uppercase;color:#f6f4ee;text-decoration:none">${cta}</a></td></tr></table></td></tr></table>
${note ? `<p style="margin:20px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:#8a888f;text-align:center">${e(note)}</p>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px"><tr><td style="border-top:1px solid #d5d2c9;padding-top:20px"><p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:#8a888f">If the button doesn't work, copy and paste this link into your browser:</p><p style="margin:0;font-family:'Courier New',monospace;font-size:12px;line-height:18px;word-break:break-all"><a href="${e(link)}" style="color:#3f3f45">${e(link)}</a></p></td></tr></table>
</td></tr></table></td></tr><tr><td align="center" style="padding:24px 20px 0"><p style="margin:0 0 10px;font-family:${FONT};font-size:12px;line-height:18px;color:#8a888f">${e(footer)}${confirmation ? "" : ` <a href="${billing}" style="color:#3f3f45">Manage alerts in Billing</a>, or ask the account owner.`}</p><p style="margin:0;font-family:${MONO};font-size:10px;line-height:18px;letter-spacing:2px;color:#8a888f">CAMELAI · DURABLE AGENTS. HOSTED.</p></td></tr></table>
<!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  return { subject, html, text: [heading, sentence, ...details.map(([k,v]) => `${k}: ${v}`), `${cta}: ${link}`, note, footer,
    ...confirmation ? [] : [`Manage alerts in Billing: ${billing}, or ask the account owner.`], "camelAI · Durable agents. Hosted."].filter(Boolean).join("\n\n") };
}
