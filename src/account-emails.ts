/**
 * The mail sign-up, password reset and adding a password send (src/email-accounts.ts), laid out as billing mail is
 * (src/billing-emails.ts). Each names no account id and carries at most one link.
 */
export type AccountEmailKind = "verify" | "exists" | "google" | "reset" | "add" | "taken";
export interface AccountEmail { subject: string; html: string; text: string }

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "'Silkscreen','Courier New',Courier,monospace";

/** `link` is the token's page for verify, add and reset; the others link to sign-in. */
export function accountEmail(kind: AccountEmailKind, origin: string, link?: string): AccountEmail {
  origin = new URL(origin).origin;
  const signIn = `${origin}/console/`;
  const { subject, heading, sentence, cta, note, footer } = {
    verify: {
      subject: "Confirm your email for camelRun", heading: "Finish creating your account",
      sentence: "Open the link and enter the password you chose to confirm this address and create your camelRun account.",
      cta: "Confirm email", note: "The link works once and expires in 24 hours.",
      footer: "Someone signed up for camelRun with this address. If it wasn't you, ignore this email: no account is made.",
    },
    exists: {
      subject: "Someone tried to sign up for camelRun with your email", heading: "You already have an account",
      sentence: "Someone tried to create a camelRun account with this address, which already has one. If it was you, sign in, or reset your password from the sign-in page.",
      cta: "Sign in", note: "",
      footer: "If it wasn't you, ignore this email: nothing changed.",
    },
    google: {
      subject: "Your camelRun account signs in with Google", heading: "Sign in with Google",
      sentence: "Someone asked for a camelRun password for this address, whose account signs in with Google. Sign in with Google; to sign in with a password too, add one on the Account page.",
      cta: "Sign in", note: "",
      footer: "If it wasn't you, ignore this email: nothing changed.",
    },
    reset: {
      subject: "Reset your camelRun password", heading: "Reset your password",
      sentence: "Open the link to choose a new password. Every session signed in with the old one ends.",
      cta: "Reset password", note: "The link works once and expires in an hour.",
      footer: "Someone asked to reset the password of the camelRun account that signs in with this address. If it wasn't you, ignore this email: your password stays as it is.",
    },
    add: {
      subject: "Confirm your email for camelRun sign-in", heading: "Confirm your sign-in address",
      sentence: "Open the link and enter the password you chose to sign in to your camelRun account with this address.",
      cta: "Confirm email", note: "The link works once and expires in 24 hours.",
      footer: "Someone signed in to camelRun asked to sign in with this address. If it wasn't you, ignore this email: nothing changes.",
    },
    taken: {
      subject: "Your email is already used on camelRun", heading: "This address already has an account",
      sentence: "Someone asked to sign in to a camelRun account with this address, but it already signs in to another account, so nothing changed.",
      cta: "Sign in", note: "",
      footer: "If it wasn't you, ignore this email.",
    },
  }[kind];
  const url = link ?? signIn;
  const e = escape;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${e(subject)}</title>
<style>@font-face{font-family:Silkscreen;src:url('${origin}/console/email/silkscreen.woff2') format('woff2');font-weight:400;font-style:normal}</style></head>
<body bgcolor="#f6f4ee" style="margin:0;padding:0;background-color:#f6f4ee">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${e(sentence)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6f4ee"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:440px"><tr><td align="center" style="padding:0 0 28px"><img src="${origin}/console/email/logo.png" width="133" height="32" alt="camelAI" style="display:block;border:0;width:133px;height:32px"></td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#efede6" style="background-color:#efede6;border:1px solid #d5d2c9">
<tr><td style="padding:28px 28px 32px"><p style="margin:0 0 14px;font-family:${MONO};font-size:10px;line-height:18px;letter-spacing:3px;color:#8a888f">CAMELRUN · ACCOUNT</p>
<h1 style="margin:0 0 12px;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:#111113">${e(heading)}</h1>
<p style="margin:0 0 24px;font-family:${FONT};font-size:14px;line-height:22px;color:#3f3f45">${e(sentence)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#111113"><a href="${e(url)}" style="display:inline-block;padding:13px 28px;font-family:${MONO};font-size:11px;line-height:18px;letter-spacing:3px;text-transform:uppercase;color:#f6f4ee;text-decoration:none">${e(cta)}</a></td></tr></table></td></tr></table>
${note ? `<p style="margin:20px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:#8a888f;text-align:center">${e(note)}</p>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px"><tr><td style="border-top:1px solid #d5d2c9;padding-top:20px"><p style="margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:#8a888f">If the button doesn't work, copy and paste this link into your browser:</p><p style="margin:0;font-family:'Courier New',monospace;font-size:12px;line-height:18px;word-break:break-all"><a href="${e(url)}" style="color:#3f3f45">${e(url)}</a></p></td></tr></table>
</td></tr></table></td></tr><tr><td align="center" style="padding:24px 20px 0"><p style="margin:0 0 10px;font-family:${FONT};font-size:12px;line-height:18px;color:#8a888f">${e(footer)}</p><p style="margin:0;font-family:${MONO};font-size:10px;line-height:18px;letter-spacing:2px;color:#8a888f">CAMELAI · DURABLE AGENTS. HOSTED.</p></td></tr></table>
</td></tr></table></body></html>`;
  return { subject, html, text: [heading, sentence, `${cta}: ${url}`, note, footer, "camelAI · Durable agents. Hosted."].filter(Boolean).join("\n\n") };
}
