import { streamModelResponse } from "../../worker/src/providers.ts";
import { buildConversationMessages } from "../../worker/src/turn-loop.ts";
import { ApiError, type Env, type StoredMessage } from "../../worker/src/types.ts";

export default {
  async fetch(request: Request, env: Env) {
    const stored = await request.json<StoredMessage[]>();
    const original = JSON.stringify(stored);
    const chunks = [];
    try {
      for await (const chunk of streamModelResponse({
        env,
        tenantId: "fixture-tenant",
        model: "azure/gpt-6.2-sol",
        messages: buildConversationMessages(null, stored),
      })) {
        chunks.push(chunk);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    return Response.json({ chunks, storedUnchanged: JSON.stringify(stored) === original });
  },
};
