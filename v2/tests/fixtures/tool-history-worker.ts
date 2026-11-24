import type { Message as PiAiMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, Tx } from "@earendil-works/pi-durable";
import { importLegacyTranscriptToPi } from "../../worker/src/pi/migrate.ts";
import { parsePiModelRef, streamPiModel } from "../../worker/src/pi/models.ts";
import { ApiError, type Env, type StoredMessage } from "../../worker/src/types.ts";

export default {
  async fetch(request: Request, env: Env) {
    const stored = await request.json<StoredMessage[]>();
    const original = JSON.stringify(stored);
    const messages: PiAiMessage[] = [];
    let seq = 0;
    const fakeTx = {
      async appendEntry(_kindOrConv: unknown, _convOrEntry: unknown, maybeEntry?: { model?: PiAiMessage[] }) {
        const entry = maybeEntry ?? (_convOrEntry as { model?: PiAiMessage[] });
        if (entry?.model) {
          messages.push(...entry.model);
        }
        return { id: ++seq as EntryId };
      },
    } as unknown as Tx;
    await importLegacyTranscriptToPi(
      fakeTx,
      1 as ConversationId,
      null,
      stored,
      parsePiModelRef("azure/gpt-6.2-sol", env),
    );
    const chunks = [];
    try {
      for await (const chunk of streamPiModel({
        env,
        tenantId: "fixture-tenant",
        model: "azure/gpt-6.2-sol",
        messages,
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
