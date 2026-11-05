import { Harness, createRegistry, defineTool, hook, ToolTask, type Conversation, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { createReadTool } from '@earendil-works/pi-durable/tools';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { createInlineCodemodeSandbox } from '@earendil-works/pi-codemode/cloudflare';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type Provider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream, type AssistantMessage, type ImageContent, type Model, type TranscriptContext } from '@earendil-works/pi-ai';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { obj, lit, str } from '@earendil-works/pi-schema';
import { parseMarker } from './marker.ts';

const sourceImage: ImageContent = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGMwaDjwnxLMMGrAqAGjBgwXAwBvoG8f8eaJTwAAAABJRU5ErkJggg==' };
const model: Model<'openai-completions'> = { id: 'image-probe', provider: 'camelrun-proto', api: 'openai-completions', name: 'Image probe', baseUrl: 'https://invalid.test', input: ['text', 'image'], reasoning: false, contextWindow: 262144, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

/** Exercise real Pi state and code mode in a deployed DO; no external model credentials. */
export async function runPiProbe(storage: DurableObjectStorage, externalize: (image: ImageContent) => Promise<ImageContent>) {
  const prefix = 'probe_' + crypto.randomUUID().replaceAll('-', '') + '_';
  const reports: string[] = [];
  let afterToolCalls = 0;
  let markedImages = 0;
  let providerCalls = 0;
  const requestImages: number[] = [];
  const stream = (_model: Model<'openai-completions'>, context: TranscriptContext) => {
    const out = createAssistantMessageEventStream();
    queueMicrotask(() => {
      providerCalls++;
      requestImages.push(context.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'image' && !!parseMarker(b.data)).length : 0), 0));
      const latest = [...context.messages].reverse().find(m => m.role === 'user');
      const text = latest && typeof latest.content === 'string' ? latest.content : latest && Array.isArray(latest.content) ? latest.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
      const since = latest ? context.messages.slice(context.messages.lastIndexOf(latest) + 1) : [];
      const code = text.startsWith('code:') && !since.some(m => m.role === 'toolResult');
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: code ? [{ type: 'toolCall', id: 'probe-code-' + providerCalls, name: 'codemode', arguments: { code: text.slice(5) } }] : [{ type: 'text', text: 'Probe summary and answer.' }], stopReason: code ? 'toolUse' : 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      out.push({ type: 'start', partial: message });
      out.push({ type: 'done', reason: code ? 'toolUse' : 'stop', message });
    });
    return out;
  };
  const models = createModels();
  const provider: Provider<'openai-completions'> = { id: model.provider, name: 'Probe', auth: { apiKey: { name: 'Synthetic probe', resolve: async () => ({ auth: { apiKey: 'synthetic-probe-not-a-credential' } }) } }, getModels: () => [model], stream, streamSimple: stream };
  models.setProvider(provider);
  const registry = createRegistry();
  const read = defineTool({ name: 'read', description: 'Read the synthetic image', parameters: obj({}), structuredOutputSchema: obj({ type: lit('image'), data: str(), mimeType: str() }), replay: 'safe', execute: async () => ({ output: [sourceImage], structuredOutput: { ...sourceImage } }) });
  registry.install({ name: 'probe-images', tools: [read], hooks: [hook(ToolTask, { afterTool: async (_call, result) => {
    afterToolCalls++;
    const images = new Map<string, ImageContent>();
    const mark = async (block: ImageContent) => {
      if (parseMarker(block.data)) return block;
      const cached = images.get(block.data);
      if (cached) return cached;
      markedImages++;
      const marked = await externalize(block);
      images.set(block.data, marked);
      return marked;
    };
    const output = await Promise.all((result.output ?? []).map(block => block.type === 'image' ? mark(block) : block));
    const value = result.structuredOutput;
    const structuredOutput = value && typeof value === 'object' && !Array.isArray(value) && value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string'
      ? { ...await mark({ type: 'image', data: value.data, mimeType: value.mimeType }) } : value;
    return { ...result, output, structuredOutput };
  } })] });
  const sandbox = createInlineCodemodeSandbox({ memoryLimitBytes: 8 * 1024 * 1024, interruptBudget: 100000 });
  registry.install(createCodemodeExtension({ sandbox, models: false }));
  const options = { models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 }, contextRetentionMs: 0 }, onReport: (report: { error: unknown }) => reports.push(String(report.error).slice(0, 300)) };
  let harness = await Harness.open(await openDurableObjectSqliteStorage(storage, { prefix }), options, BACKGROUND_CONTEXT);
  let root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, maxTurns: 4 } });
  // The native reader sees a controlled binary file capability; no filesystem or user data.
  const nativeReadCases: Record<string, boolean> = {};
  for (const kind of ['small', 'oversized', 'wide'] as const) {
    const bytes = Uint8Array.from(atob(sourceImage.data), c => c.charCodeAt(0));
    if (kind === 'wide') new DataView(bytes.buffer).setUint32(16, 3000);
    const size = kind === 'oversized' ? 5 * 1024 * 1024 : bytes.length;
    let fullRead = false;
    const info = { name: 'image.png', path: '/image.png', kind: 'file' as const, size, mtimeMs: 0 };
    const env = {
      absolutePath: async () => ({ ok: true as const, value: '/image.png' }),
      exists: async () => ({ ok: true as const, value: true }),
      openBinaryReader: async () => ({ ok: true as const, value: {
        info: async () => ({ ok: true as const, value: info }),
        read: async (offset: number, length: number) => { fullRead ||= length >= size; return { ok: true as const, value: bytes.slice(offset, offset + length) }; },
        close: async () => {},
      } }),
    };
    // This fixture supplies exactly the capabilities used by createReadTool.execute;
    // unrelated tool/runtime operations are deliberately unavailable.
    const api = new Proxy({} as ToolExecutionApi, { get(_target, property) {
      if (property === 'env') return env;
      if (property === 'models') return models;
      if (property === 'agent') return () => root.agent(BACKGROUND_CONTEXT);
      throw new Error('Native-read fixture accessed an unexpected runtime capability');
    } });
    const result = await createReadTool().execute({ path: '/image.png' }, api, BACKGROUND_CONTEXT);
    nativeReadCases[kind] = kind === 'small' ? !result.isError && !!result.output?.some(b => b.type === 'image') : result.isError === true;
    if (kind === 'oversized') nativeReadCases.oversizedRefusedBeforeFullRead = !fullRead;
  }
  const marker = await externalize(sourceImage);
  const plainMarker = await sandbox.execute('image({type:"image",mimeType:"image/png",data:"' + btoa('ref:synthetic') + '"});');
  const malformed = await sandbox.execute('image({type:"image",mimeType:"image/png",data:"!!!!"});');
  const directMarker = await sandbox.execute('image(' + JSON.stringify(marker) + ');');
  if (!parseMarker(marker.data)) throw new Error('Externalizer did not produce a marker');
  const submit = async (conversation: Conversation, content: string | ImageContent[]) => {
    const submission = await conversation.submit({ type: 'input', content }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  };
  await submit(root, [marker]);
  const before = await root.context(BACKGROUND_CONTEXT);
  const beforeJson = JSON.stringify(before.messages);
  const journal = await root.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
  const last = journal.items.at(-1);
  if (!last) throw new Error('Pi probe journal is empty');
  const fork = await root.fork(last.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
  const forkJson = JSON.stringify((await fork.context(BACKGROUND_CONTEXT)).messages);
  const forkPreserved = forkJson.includes(marker.data);
  await harness.close(BACKGROUND_CONTEXT);
  harness = await Harness.open(await openDurableObjectSqliteStorage(storage, { prefix }), options, BACKGROUND_CONTEXT);
  root = await harness.root(BACKGROUND_CONTEXT);
  const replayJson = JSON.stringify((await root.context(BACKGROUND_CONTEXT)).messages);
  const replayPreserved = replayJson === beforeJson;
  await submit(root, 'code:image(await tools.read({})); text("code-image-ok");');
  const codeContext = await root.context(BACKGROUND_CONTEXT);
  const codeResult = codeContext.messages.filter(m => m.role === 'toolResult');
  const codeText = codeResult.map(m => JSON.stringify(m)).join('\n');
  const codeImageAccepted = codeResult.some(m => m.content.some(b => b.type === 'image' && !!parseMarker(b.data)));
  const codeSucceeded = codeText.includes('Script completed') && codeText.includes('code-image-ok');
  const preCompact = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  const compact = await root.compact('Summarize the image probe.', BACKGROUND_CONTEXT);
  const compactResult = await harness.waitForTask(compact, BACKGROUND_CONTEXT);
  const compactContext = await root.context(BACKGROUND_CONTEXT);
  const postCompact = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  const historicalMarkers = postCompact.items.filter(e => JSON.stringify(e).includes(marker.data)).length;
  const result = {
    prefix, userInputMarkerAccepted: beforeJson.includes(marker.data), journalEntries: journal.items.length,
    replayPreserved, replayKind: 'Harness close/reopen over the same live DO SQLite storage; process eviction tested separately',
    forkPreserved, afterToolCalls, markedImages, codeImageAccepted, codeSucceeded,
    codeDiagnostics: codeResult.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n').slice(0, 2000),
    codeOutputSavedMarkerCaveat: codeText.includes('could not be saved') ? 'No execution filesystem: Pi could not save an artifact; output image remained marked' : 'Pi artifact saving was invoked; host must resolve marker bytes before persisting visible image files',
    compaction: compactResult.state, compactContextMessages: compactContext.messages.length,
    compactionAddedEntries: postCompact.items.length - preCompact.items.length, historicalMarkers,
    tokenEstimateOriginal: estimateMessageTokens({ role: 'user', content: [sourceImage], timestamp: 0 }),
    tokenEstimateMarker: estimateMessageTokens({ role: 'user', content: [marker], timestamp: 0 }),
    nativeReadCases, plainReferenceRejected: !plainMarker.ok, malformedBase64Rejected: !malformed.ok, validPngMarkerAccepted: directMarker.ok,
    markerBase64Chars: marker.data.length, providerCalls, requestImages, reports,
  };
  await harness.close(BACKGROUND_CONTEXT);
  await sandbox.close();
  return result;
}
