import { z } from "@hono/zod-openapi";

const SEND_TEXT = "Send {\"text\": \"...\"}, or attach audio to transcribe";
export const TRANSCRIBE = z.boolean().optional().openapi({ description: "Whether this file is transcribed for the model (audio only): default true for audio (an audio/* content type), false for anything else. See the voice and audio guide" });

export const SpendLimitInput = z.object({ usd: z.number().min(0).max(1_000_000) }).strict().openapi("SpendLimitInput", {
  description: "The most the agent may spend on model calls (their token cost, compaction included) from when this is set: a new value starts counting from zero. At it, new prompts get 402 and a running turn ends with stopped \"spend_limit\"",
});

export const PromptInput = z.object({
  endUser: z.string().min(1).max(200).optional().openapi({ description: "Charge this prompt to an existing end user of this tenant instead of the agent subject. Tenant API key only. A steer joins only a turn with the same endUser selection. Child tasks, their notifications and messages inherit the run payer; child tool identity stays the owner. Later prompts without it use the agent subject" }),
  text: z.string({ error: SEND_TEXT }).optional().openapi({ description: "The message. It may be left out when the message attaches audio, whose transcript is then the message" }),
  actor: z.string().optional().openapi({ description: "Who is acting in this turn (a user id in your app): `act` in its tools' identity tokens" }),
  from: z.strictObject({
    id: z.string().openapi({ description: "The sender's id in your app; the model may rely on it" }),
    name: z.string().optional().openapi({ description: "Display name, chosen by the sender" }),
    username: z.string().optional().openapi({ description: "Handle, chosen by the sender" }),
    thread: z.string().optional().openapi({ description: "The thread of a shared conversation the message was written in (a channel sets it: a Slack thread's ts in a channel answered by one agent). The model sees it with the sender, and its reply goes there" }),
  }).optional().openapi({ description: "Who sent this message. The model sees it in a block only the runtime can write; `from.id` is also the turn's actor unless `actor` is given" }),
  requestId: z.string().optional().openapi({ description: "Idempotency: retrying with the same id returns the same request. The user message records it, so a UI can match its own bubble" }),
  allowDisconnected: z.boolean().optional().openapi({ description: "Run even though the agent's tools need its application and none is connected (else 409 APPLICATION_NOT_CONNECTED): its calls then fail as not connected" }),
  whileRunning: z.enum(["queue", "steer"]).optional().openapi({ description: "What happens if the agent is working on a turn when this arrives. queue (default): it runs as the next turn. steer: a running turn with the same endUser selection takes it after its current step; a different payer queues a separate turn. The 202 says so at once (steer: \"accepted\"; \"queued\" when no turn could take it), and this request completes as soon as the turn takes the message (steeredInto names the turn, whose own request has its outcome; a steer_taken event marks it), so steered messages never wait for the turn's end, nor count against the agent's queue once taken. If the turn ends first, it runs as a turn of its own. With no turn running, both start one" }),
  spendLimit: SpendLimitInput.optional().openapi({ description: "This run's own budget in USD: it ends before its next model request once it has spent this. The agent's spendLimit is unchanged and counts the run too" }),
  bucket: z.string().optional().openapi({ description: "With end-user credits on (/v1/end-user-settings): the bucket of this run's payer (endUser, else the agent subject) it spends from, instead of the agent's. Only the tenant may set it" }),
  runLimits: z.strictObject({ maxResponses: z.number().int().min(1).optional(), maxSeconds: z.number().int().min(1).optional() }).optional().openapi({ description: "This run's own limits: at most this many model responses, or seconds. They only lower the agent's runLimits and the runtime's; at one, the run ends with stopped \"turn_limit\"" }),
  output: z.strictObject({
    schema: z.record(z.string(), z.unknown()).openapi({ description: "A JSON Schema for an object (type: \"object\"; at most 64 KB)", example: { type: "object", properties: { sentiment: { type: "string", enum: ["positive", "neutral", "negative"] } }, required: ["sentiment"] } }),
  }).optional().openapi({ description: "Structured output: the agent ends this run by calling a final_output tool whose arguments are the schema, checked against it (a call that does not fit goes back to the model with what is wrong). The run's outcome.result.output is that object. A model that answers in text instead is asked once more, with a reminder; a run that still ends without an output fails with code output_missing. The tool stays declared until a prompt without output. Not with whileRunning: steer" }),
  history: z.enum(["full", "none"]).optional().openapi({ deprecated: true, description: "Deprecated and ignored: every run sees the agent's history (Pi's compaction keeps its context bounded). Accepted so existing callers do not fail. For a run that sees no history, use POST /v1/runs" }),
  metadata: z.record(z.string(), z.string({ error: "metadata values must be strings" }), { error: "metadata must be an object of string values" }).optional().openapi({ description: "Your own key-value data about this message (its source, a client-side id): at most 16 keys of 1–64 characters, values of at most 512. Kept on the user message (history, events, snapshots) and the request, and sent with its run's webhook events; never shown to the model", example: { source: "web", clientMessageId: "m_123" } }),
  files: z.array(z.union([
    z.strictObject({ path: z.string().openapi({ description: "A file in the agent's mounts, e.g. one uploaded with PUT /v1/agents/{id}/uploads/{requestId}/{name}" }), transcribe: TRANSCRIBE }),
    z.strictObject({ name: z.string().optional(), data: z.string().openapi({ description: "The file's bytes, base64: at most 4 MiB across a message's inline files" }), contentType: z.string().optional(), transcribe: TRANSCRIBE }),
    z.strictObject({ url: z.string().openapi({ description: "An https URL the runtime fetches the file from (public addresses only; at most 64 MiB)" }), name: z.string().optional(), contentType: z.string().optional(), transcribe: TRANSCRIBE }),
  ])).optional().openapi({ description: "Attached files (at most 20): saved in the agent's workspace under uploads/<requestId>/, named in the message, and shown natively (images, PDFs) to models that take them. Audio is transcribed before the request is accepted, and the model reads the transcript" }),
}, { error: SEND_TEXT }).refine(prompt => !!prompt.text?.trim() || !!prompt.files?.length, SEND_TEXT).openapi("PromptInput");
