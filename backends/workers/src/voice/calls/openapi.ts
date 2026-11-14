import { z } from "@hono/zod-openapi";
import { VoiceCall, VoiceCallCreated, VoiceCallEndInput, VoiceCallInput, VoiceCallUpdate, VoiceTranscriptInput } from "./schema.ts";

const content = (schema: z.ZodType) => ({ "application/json": { schema: z.toJSONSchema(schema, { target: "draft-2020-12" }) } });
const response = (description: string, schema: z.ZodType) => ({ description, content: content(schema) });
const operation = (description: string, schema: z.ZodType, status = 200, body?: z.ZodType) => ({
  responses: { [status]: response(description, schema) },
  ...(body ? { requestBody: { content: content(body) } } : {}),
});
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const sessions = "/v1/voice/sessions";

export function workersVoicePaths() {
  return {
    [sessions]: {
      get: {
        ...operation("The tenant's voice calls, newest first", z.object({ sessions: z.tuple([]), next: z.null(), calls: z.array(VoiceCall) })),
        parameters: [
          { name: "state", in: "query", schema: { type: "string", enum: ["live", "ended"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        ],
      },
      post: operation("The call and its connection details", VoiceCallCreated, 201, VoiceCallInput),
    },
    [sessions + "/{id}"]: {
      parameters: [id],
      get: operation("The call", VoiceCall),
      patch: operation("The updated call", VoiceCall, 200, VoiceCallUpdate),
      delete: operation("The call after requesting its end", VoiceCall),
    },
    [sessions + "/{id}/end"]: {
      parameters: [id], post: operation("The call after requesting its end", VoiceCall, 200, VoiceCallEndInput),
    },
    [sessions + "/{id}/transcript"]: {
      parameters: [id], post: operation("The accepted utterance's sequence number", z.object({ seq: z.number() }), 202, VoiceTranscriptInput),
    },
  };
}
