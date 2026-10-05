/**
 * Transactional mail through Amazon SES. Billing, Get Help and account mail all send through it;
 * SES has no idempotency key, so a caller that retries delivers at least once.
 */
export interface MailTransportOptions {
  from: string;
  displayName: string;
  region?: string;
  configurationSet?: string;
}
export interface OutgoingMail {
  to: string;
  /** One more recipient, alongside `to`. */
  cc?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: { Name: string; Value: string }[];
  /** SES message tags, for correlating provider feedback. */
  tags?: { Name: string; Value: string }[];
}
export type MailResult = { messageId: string | undefined } | { suppressed: true };

export class MailTransport {
  private readonly options: MailTransportOptions;
  private client?: import("@aws-sdk/client-sesv2").SESv2Client;
  constructor(options: MailTransportOptions) { this.options = options; }

  async send(mail: OutgoingMail, signal: AbortSignal): Promise<MailResult> {
    const { from, displayName } = this.options;
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const { NodeHttpHandler } = await import("@smithy/node-http-handler");
    this.client ??= new SESv2Client({ region: this.options.region, maxAttempts: 1,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 15_000 }) });
    const result = await this.client.send(new SendEmailCommand({
      FromEmailAddress: `=?UTF-8?B?${Buffer.from(displayName).toString("base64")}?= <${from}>`,
      Destination: { ToAddresses: [mail.to], ...(mail.cc ? { CcAddresses: [mail.cc] } : {}) },
      ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}),
      ConfigurationSetName: this.options.configurationSet,
      EmailTags: mail.tags,
      Content: { Simple: { Subject: { Data: mail.subject, Charset: "UTF-8" }, Headers: mail.headers, Body: {
        Html: { Data: mail.html, Charset: "UTF-8" }, Text: { Data: mail.text, Charset: "UTF-8" },
      } } },
    }), { abortSignal: signal });
    return { messageId: result.MessageId };
  }

  destroy() { this.client?.destroy(); }
}
