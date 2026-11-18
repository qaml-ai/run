export interface ByteStreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
  cancel?(reason?: unknown): Promise<unknown>;
}
export interface ByteStreamLike { getReader(): ByteStreamReaderLike; }

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: ByteStreamLike | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | ArrayBuffer; signal?: AbortSignal },
) => Promise<ResponseLike>;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "close", listener: (event: unknown) => void): void;
}
export type WebSocketConstructorLike = new (url: string) => WebSocketLike;

export interface CamelRunOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: FetchLike;
  WebSocket?: WebSocketConstructorLike;
}
export interface CamelRunAdminOptions { baseUrl: string; adminKey: string; fetch?: FetchLike; }
export interface CreateTenantOptions extends CamelRunAdminOptions { name: string; initialCreditsUsd?: number; }
export interface CreatedTenant { tenantId: string; name: string; apiKey: string; balanceUsd: number; }

export interface TenantInfo {
  tenantId: string;
  name: string;
  balanceUsd: number;
  tier: string;
  busyAgents: { active: number; limit: number };
}

export interface ApiToken {
  id: string;
  name?: string;
  apiKey?: string;
  token?: string;
  prefix?: string;
  scopes?: string[];
  createdAt?: number;
  lastUsedAt?: number | null;
}
export interface CreateTokenInput { name?: string; scopes?: string[]; expiresInSeconds?: number; }
export interface ProviderConfig { apiKey: string; baseUrl?: string; }

export interface BillingUsageEntry {
  day?: string;
  model?: string;
  runsCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  vmMs?: number;
  costUsd?: number;
  amountUsd?: number;
  [key: string]: unknown;
}
export interface BillingInfo { balanceUsd: number; monthlyCapUsd: number | null; usage: BillingUsageEntry[]; }
export interface AddCreditsInput { amountUsd: number; refId?: string; note?: string; adminKey: string; }

export type BuiltinCategory =
  | "files" | "bash" | "codemode" | "delegate" | "workflows" | "web_search" | "web_fetch" | "human"
  | (string & {});

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  auth?: { type: "runtime" };
  audience?: string;
  allowTools?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  url?: string;
  headers?: Record<string, string>;
  requiresApproval?: boolean;
}
export interface LocalTool<TArgs = Record<string, unknown>, TResult = unknown> extends Omit<ToolDefinition, "url"> {
  execute: (args: TArgs) => TResult | Promise<TResult>;
}

export interface QueueConfig { mode: "each" | "batch"; windowMs?: number; }
export interface DreamingConfig { enabled: boolean; idleSeconds?: number; }

export interface AgentConfig {
  model?: string;
  instructions?: string;
  definition?: string;
  tools?: Array<ToolDefinition | LocalTool<any, any>>;
  mcpServers?: McpServerConfig[];
  toolIdentity?: { subject: string; context?: Record<string, unknown> };
  builtins?: BuiltinCategory[];
  queue?: QueueConfig;
  repoId?: string | null;
  branch?: string;
  spendLimitUsd?: number;
  idleTtlSeconds?: number;
  dreaming?: DreamingConfig;
}
export type DefinitionConfig = Omit<AgentConfig, "tools" | "definition" | "toolIdentity"> & { name?: string; tools?: ToolDefinition[]; };
export interface AgentDefinition extends DefinitionConfig { slug: string; createdAt?: number; updatedAt?: number; }

export interface AgentSummary {
  id: string;
  key: string;
  agentToken?: string;
  repoId?: string | null;
  lineage?: string | null;
  branch?: string;
  commit?: string;
  model?: string;
  instructions?: string;
  definition?: string | null;
  status?: "idle" | "running" | (string & {});
  activeRunId?: string | null;
  messageCount?: number;
  lastRun?: RunRecord | null;
  forkedFrom?: { agentId: string; atSeq: number };
  created?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export type RunStatus = "queued" | "running" | "input_required" | "completed" | "failed" | "cancelled";

/** A file already written to the agent's repository. */
export interface RunFile {
  path: string;
  commit: string;
  contentType: string;
}

export interface V1HistoryImport {
  source: string;
  messages: unknown[];
  previous?: string;
  attachments?: Array<{ messageIndex: number; files: RunFile[] }>;
}

export interface RunOptions {
  actor?: string;
  files?: RunFile[];
  idempotencyKey?: string;
  whileRunning?: "queue" | "steer";
  wait?: boolean;
  outputSchema?: Record<string, unknown>;
  maxSteps?: number;
  spendLimitUsd?: number;
  throwOnError?: boolean;
  signal?: AbortSignal;
}
export interface StatelessRunOptions {
  input: string;
  model?: string;
  instructions?: string;
  outputSchema?: Record<string, unknown>;
  tools?: ToolDefinition[];
  maxSteps?: number;
}

export interface HumanInput {
  id: string;
  runId?: string;
  toolCallId?: string;
  kind?: "approval" | "question" | (string & {});
  type?: "approval" | "question" | (string & {});
  prompt?: Record<string, unknown> | string;
  status?: "pending" | "answered" | "denied" | "expired" | (string & {});
  expiresAt?: number;
  approved?: boolean;
  answer?: unknown;
}
export interface RunToolCall { id: string; name: string; ok: boolean; }
export interface RunUsage { inputTokens: number; outputTokens: number; costUsd: number; vmMs: number; }

export interface RunRecord<TOutput = unknown> {
  actor?: string;
  id: string;
  agentId: string;
  idempotencyKey: string | null;
  startedAt: number;
  status: RunStatus;
  text: string;
  output: TOutput | null;
  batchedInto: string | null;
  inputs: HumanInput[];
  toolCalls: RunToolCall[];
  filesChanged: string[];
  usage: RunUsage;
  error: string | { code?: string; message: string } | null;
}

export interface AgentEvent {
  seq: number;
  runId?: string | null;
  type: string;
  event?: unknown;
  data?: Record<string, unknown> | unknown;
  createdAt?: number;
  [key: string]: unknown;
}

export interface HistoryMessage {
  seq?: number;
  runId?: string | null;
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  content: unknown;
  tokensEst?: number;
  createdAt?: number;
}

export interface RepoInfo { repoId: string; name?: string | null; lineage: string; defaultRef: string; commit: string; tree?: string; createdAt?: number; }
export interface RepoEntry { path: string; type: "file" | "dir" | "symlink" | (string & {}); size: number; mode: number; hash: string; }
export interface RepoPutFile { path: string; content?: string; base64?: string; mode?: number; }
export interface RepoMoveFile { from: string; to: string; }
export interface RepoWriteInput {
  ref?: string; expectedCommit?: string; holder?: string; author?: string; message?: string;
  puts?: RepoPutFile[]; deletes?: string[]; moves?: RepoMoveFile[];
  path?: string; content?: string; base64?: string; mode?: number;
}
export interface RepoWriteResult { commit: string; tree: string; changed: string[]; totalBytes: number; }
export interface RepoReadResult { commit: string; path: string; size: number; mode: number; binary: boolean; content: string | null; base64: string | null; }
export interface RepoGrepMatch { path: string; line: number; column: number; text: string; }
export interface RepoCommit { commit: string; tree: string; parents: string[]; author: string; message: string; createdAt: number; }

export interface DecisionRequest<TChoice extends string = string> { input: string; choices: readonly TChoice[]; instructions?: string; model?: string; }
export interface DecisionResult<TChoice extends string = string> { choice: TChoice; confidence: number; scores: Record<TChoice, number>; costUsd: number; }
export interface VoiceSession { sessionId: string; provider: "openai" | "elevenlabs"; clientSecret: string; wsUrl: string; }

export interface ChannelConfig {
  id?: string;
  name?: string;
  kind?: "slack" | "email" | "http" | (string & {});
  type?: "slack" | "email" | "http" | (string & {});
  definition?: string;
  agentConfig?: AgentConfig;
  outboundUrl?: string;
  secret?: string;
  [key: string]: unknown;
}
export interface ChannelInfo extends ChannelConfig { id: string; createdAt?: number; }
export interface WebhookEndpoint { id: string; url: string; events: string[]; enabled?: boolean; secret?: string; createdAt?: number; }

export interface ScheduleCreateInput { prompt: string; cron?: string; cronExpr?: string; intervalSeconds?: number; enabled?: boolean; }
export interface AgentSchedule { id: string; prompt: string; cron?: string | null; cronExpr?: string | null; intervalSeconds?: number | null; nextDueAt?: number | null; nextRunAt?: number | null; enabled?: boolean; }
export interface WorkflowRunResult<TResult = unknown> { id?: string; status?: string; result?: TResult; output?: TResult; [key: string]: unknown; }

export interface TranscribeInput {
  audioBase64?: string;
  file?: { arrayBuffer(): Promise<ArrayBuffer>; type?: string } | Uint8Array | ArrayBuffer;
  filename?: string; mimeType?: string; url?: string; text?: string; model?: string; language?: string; prompt?: string;
}
export interface TranscriptionResult { text: string; language?: string; costUsd?: number; [key: string]: unknown; }
export interface SpeechInput { input: string; voice?: string; model?: string; format?: string; }
export interface SpeechResult { audio?: Uint8Array; audioBase64?: string; contentType: string; id?: string; url?: string; costUsd?: number; }
export interface GenerateImageInput { prompt: string; model?: string; size?: string; quality?: string; format?: string; }
export interface ImageRecord { id: string; url?: string; contentType?: string; base64?: string; data?: Uint8Array; prompt?: string; costUsd?: number; }

export class CamelRunError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly run?: RunRecord<unknown>;

  constructor(message: string, options?: { code?: string; status?: number; run?: RunRecord<unknown>; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CamelRunError";
    this.code = options?.code ?? "camelrun_error";
    this.status = options?.status;
    this.run = options?.run;
  }
}
