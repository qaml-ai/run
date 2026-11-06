import { InboxDoc, LiveDoc, type Conversation, type InputSubmissionDraft } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { steeringCanJoin } from './steering-placement.ts';

type UserInput = InputSubmissionDraft['content'];
export type MessageCandidate = { owner: string; nativeRequest: string; resumeOwner?: string };
export type MessageAdmission = {
  requestId: string;
  content: UserInput;
  entry: NonNullable<InputSubmissionDraft['entry']>;
  candidate?: MessageCandidate;
  legacyOwner?: string;
  held: readonly { id: string; prompt: UserInput; startedAt: number }[];
};

/** Classify and queue together. An own turn is queued only after its caller has taken a wake. */
export function admitAgentMessage(root: Conversation, input: MessageAdmission, mode: 'join' | 'own') {
  return root.commit(async tx => {
    const existing = await tx.submissionByRequest(root.id, input.requestId);
    if (existing) {
      const entry = existing.entry === undefined
        ? (await tx.doc(InboxDoc, root.id)).items.find(item => item.id === existing.id)?.entry
        : await tx.entry(existing.entry);
      const data = entry?.data as { logicalOwner?: string | null } | undefined;
      return { submitted: true as const, owner: data && Object.hasOwn(data, 'logicalOwner') ? data.logicalOwner ?? null : input.legacyOwner };
    }
    const candidate = mode === 'join' ? input.candidate : undefined;
    let owner = candidate?.owner ?? null;
    if (mode === 'join' && !candidate) return { submitted: false as const };
    if (candidate) {
      const live = await tx.doc(LiveDoc, root.id);
      const native = await tx.submissionByRequest(root.id, candidate.nativeRequest);
      if (!steeringCanJoin(native) || !native || !live.run?.inputs.includes(native.id)) return { submitted: false as const };
      const entry = native.entry === undefined ? undefined : await tx.entry(native.entry);
      const data = entry?.data as { logicalOwner?: string | null } | undefined;
      if (data && Object.hasOwn(data, 'logicalOwner')) owner = data.logicalOwner ?? candidate.resumeOwner ?? candidate.nativeRequest;
    }
    await root.submit(tx, { type: 'input', requestId: input.requestId, content: input.content, whenBusy: owner ? 'steer' : 'followUp',
      entry: { kind: owner ? 'camel.steer' : 'camel.prompt', data: { ...(input.entry.data as Record<string, unknown>), logicalOwner: owner } as never } });
    for (const value of [...input.held].sort((a, b) => a.startedAt - b.startedAt))
      await tx.appendEntry(root.id, { kind: 'camel.steer', data: { requestId: value.id }, model: [{ role: 'user', content: value.prompt, timestamp: Date.now() }] });
    return { submitted: true as const, owner };
  }, BACKGROUND_CONTEXT);
}
