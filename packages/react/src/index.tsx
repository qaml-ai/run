/**
 * React bindings for an agent chat: a provider that holds the chat with the user's agent, and hooks
 * that read it. Every hook subscribes to only what it returns, so a streamed token re-renders the
 * message it belongs to, not the page.
 *
 *   <AgentProvider endpoint="/api/agent">
 *     <MyChat />
 *   </AgentProvider>
 *
 *   function MyChat() {
 *     const messages = useMessages();
 *     const send = useSend();
 *     const { status, stop } = useAgentStatus();
 *     …
 *   }
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import {
  createAgentChat,
  type AgentChat, type AgentChatOptions, type ChatError, type ChatInput, type ChatMessage, type ChatSnapshot, type ChatStatus,
  type InputAnswer, type InputValue, type SendOptions, type ToolPart,
} from "@camelai/agent-runtime/chat";

export type * from "@camelai/agent-runtime/chat";
export { answerValue, createAgentChat, projectMessages } from "@camelai/agent-runtime/chat";

/** What a tool renderer gets: the call, and the means to answer what it waits on. */
export interface ToolRenderProps {
  part: ToolPart;
  name: string;
  args: Record<string, unknown>;
  state: ToolPart["state"];
  result: ToolPart["result"];
  progress: ToolPart["progress"];
  input: ChatInput | undefined;
  /** Answer the call's input (approve with true, choose a label, fill a form). */
  answer(value: InputValue | InputAnswer): Promise<void>;
}
export type ToolRenderer = ComponentType<ToolRenderProps>;
export type ToolRenderers = Record<string, ToolRenderer>;

interface Registry {
  get(name: string): ToolRenderer | undefined;
  set(name: string, renderer: ToolRenderer): () => void;
  subscribe(listener: () => void): () => void;
  version(): number;
}
function createRegistry(): Registry {
  const renderers = new Map<string, ToolRenderer[]>();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => { version++; for (const listener of [...listeners]) listener(); };
  return {
    get: name => renderers.get(name)?.at(-1),
    set(name, renderer) {
      renderers.set(name, [...renderers.get(name) ?? [], renderer]);
      changed();
      return () => { renderers.set(name, (renderers.get(name) ?? []).filter(item => item !== renderer)); changed(); };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
  };
}

interface AgentContextValue { chat: AgentChat; registry: Registry; tools: ToolRenderers }
const AgentContext = createContext<AgentContextValue | null>(null);

export type UseAgentChatOptions = Omit<AgentChatOptions, "autoConnect">;

/**
 * A chat with the user's agent, connected while the component is mounted. A new `endpoint` or
 * `thread` is a new chat; the other options are read when used, so they may change freely.
 */
export function useAgentChat(options: UseAgentChatOptions): AgentChat {
  const latest = useRef(options);
  latest.current = options;
  const key = `${options.endpoint}\u0000${options.thread ?? ""}`;
  const make = () => createAgentChat({
    ...options, autoConnect: false,
    headers: () => { const headers = latest.current.headers; return typeof headers === "function" ? headers() : headers ?? {}; },
    onEvent: event => latest.current.onEvent?.(event),
    onError: error => latest.current.onError?.(error),
  });
  const [held, setHeld] = useState(() => ({ key, chat: make() }));
  let chat = held.chat;
  if (held.key !== key) {
    chat = make();
    setHeld({ key, chat });
  }
  useEffect(() => {
    chat.connect();
    return () => chat.disconnect();
  }, [chat]);
  return chat;
}

export interface AgentProviderProps extends Partial<UseAgentChatOptions> {
  /** A chat you made yourself (`useAgentChat` or `createAgentChat`), instead of `endpoint`. */
  chat?: AgentChat;
  /** Renderers for tool calls, by tool name (see `useToolRenderer`). */
  tools?: ToolRenderers;
  children?: ReactNode;
}

/** Holds the chat with the user's agent for the hooks and components below it. */
export function AgentProvider({ chat, tools, children, ...options }: AgentProviderProps) {
  if (chat) return <Provide chat={chat} tools={tools}>{children}</Provide>;
  if (!options.endpoint) throw new Error("AgentProvider needs an endpoint (your agent handler's URL, e.g. \"/api/agent\") or a chat");
  return <ProvideOwn {...options as UseAgentChatOptions} tools={tools}>{children}</ProvideOwn>;
}
function ProvideOwn({ tools, children, ...options }: UseAgentChatOptions & { tools?: ToolRenderers; children?: ReactNode }) {
  return <Provide chat={useAgentChat(options)} tools={tools}>{children}</Provide>;
}
function Provide({ chat, tools, children }: { chat: AgentChat; tools?: ToolRenderers; children?: ReactNode }) {
  const parent = useContext(AgentContext);
  const [registry] = useState(createRegistry);
  const value = useMemo<AgentContextValue>(() => ({ chat, registry, tools: { ...parent?.tools, ...tools } }), [chat, registry, parent?.tools, tools]);
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

function useContextValue(hook: string): AgentContextValue {
  const value = useContext(AgentContext);
  if (!value) throw new Error(`${hook} must be used inside <AgentProvider>`);
  return value;
}

/** The chat (its actions and snapshot) from the nearest AgentProvider, or the one given. */
export function useAgent(chat?: AgentChat): AgentChat {
  const context = useContext(AgentContext);
  const found = chat ?? context?.chat;
  if (!found) throw new Error("useAgent must be used inside <AgentProvider> (or given a chat)");
  return found;
}

/**
 * Part of the snapshot, re-rendering only when it changes (compared with `Object.is`, or `equal`).
 * The snapshot's messages and parts keep their identity while unchanged, so selecting them is cheap.
 */
export function useAgentSelector<T>(select: (snapshot: ChatSnapshot) => T, options: { chat?: AgentChat; equal?: (a: T, b: T) => boolean } = {}): T {
  const chat = useAgent(options.chat);
  const cache = useRef<{ snapshot: ChatSnapshot; select: unknown; value: T } | null>(null);
  const read = () => {
    const snapshot = chat.getSnapshot();
    const cached = cache.current;
    if (cached && cached.snapshot === snapshot && cached.select === select) return cached.value;
    const value = select(snapshot);
    const kept = cached && (options.equal ?? Object.is)(cached.value, value) ? cached.value : value;
    cache.current = { snapshot, select, value: kept };
    return kept;
  };
  return useSyncExternalStore(chat.subscribe, read, read);
}

/** The whole snapshot: status, messages, inputs, error. */
export function useAgentSnapshot(chat?: AgentChat): ChatSnapshot {
  const found = useAgent(chat);
  return useSyncExternalStore(found.subscribe, found.getSnapshot, found.getSnapshot);
}

/** The chat's messages, oldest first. */
export function useMessages(chat?: AgentChat): ChatMessage[] {
  return useAgentSelector(snapshot => snapshot.messages, { chat });
}

/** One message by id (re-renders only when that message changes). */
export function useMessage(id: string, chat?: AgentChat): ChatMessage | undefined {
  return useAgentSelector(snapshot => snapshot.messages.find(message => message.id === id), { chat });
}

/** Send a message: `send(text, { data })`. It shows at once and resolves once the handler took it. */
export function useSend(chat?: AgentChat): (text: string, options?: SendOptions) => Promise<{ id: string }> {
  const found = useAgent(chat);
  return useCallback((text: string, options?: SendOptions) => found.send(text, options), [found]);
}

export interface AgentStatus {
  status: ChatStatus;
  /** A turn runs or a message is on its way: show a stop button. */
  isRunning: boolean;
  error: ChatError | null;
  connected: boolean;
  stop(): Promise<void>;
  retry(messageId: string): Promise<void>;
}
/** What the agent is doing, the latest error, and `stop`. */
export function useAgentStatus(chat?: AgentChat): AgentStatus {
  const found = useAgent(chat);
  const status = useAgentSelector(snapshot => snapshot.status, { chat: found });
  const error = useAgentSelector(snapshot => snapshot.error, { chat: found });
  const connected = useAgentSelector(snapshot => snapshot.connected, { chat: found });
  return useMemo(() => ({
    status, error, connected, isRunning: status === "submitted" || status === "streaming",
    stop: () => found.stop(), retry: (id: string) => found.retry(id),
  }), [status, error, connected, found]);
}

/** What the agent waits on from the user, and the means to answer it. */
export function useInputs(chat?: AgentChat): { inputs: ChatInput[]; answer: AgentChat["answer"]; decline: AgentChat["decline"] } {
  const found = useAgent(chat);
  const inputs = useAgentSelector(snapshot => snapshot.inputs, { chat: found });
  return useMemo(() => ({ inputs, answer: found.answer, decline: found.decline }), [inputs, found]);
}

/** Older history: whether there is more, and `loadOlder()` (with `loading` while it runs). */
export function useLoadOlder(chat?: AgentChat): { hasOlder: boolean; loading: boolean; loadOlder(): Promise<boolean> } {
  const found = useAgent(chat);
  const hasOlder = useAgentSelector(snapshot => snapshot.hasOlder, { chat: found });
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const loadOlder = useCallback(async () => {
    if (busy.current) return false;
    busy.current = true; setLoading(true);
    try { return await found.loadOlder(); } finally { busy.current = false; setLoading(false); }
  }, [found]);
  return { hasOlder, loading, loadOlder };
}

/**
 * Render calls of the tool `name` with `renderer` wherever this chat is shown (generative UI), while
 * the calling component is mounted. A component's own `tools` prop comes first, then the latest
 * registration, then the provider's `tools`.
 */
export function useToolRenderer(name: string, renderer: ToolRenderer): void {
  const { registry } = useContextValue("useToolRenderer");
  useEffect(() => registry.set(name, renderer), [registry, name, renderer]);
}

/** The renderer for tool `name`: `extra`'s, else one registered with `useToolRenderer`, else the provider's. */
export function useToolRendererFor(name: string, extra?: ToolRenderers): ToolRenderer | undefined {
  const context = useContext(AgentContext);
  const subscribe = useCallback((listener: () => void) => context?.registry.subscribe(listener) ?? (() => {}), [context]);
  useSyncExternalStore(subscribe, () => context?.registry.version() ?? 0, () => 0);
  return extra?.[name] ?? context?.registry.get(name) ?? context?.tools[name];
}
