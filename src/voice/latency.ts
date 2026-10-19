import { clock } from "../node-context.ts";
import { metricLine, writeMetricLine } from "../metrics.ts";

/**
 * How long a voice turn takes, stage by stage: from the end of someone's speech to the first audio of the reply it
 * caused (docs/operations/voice-pipeline.md, "Latency instrumentation"). One `TurnClock` follows one utterance. Each
 * stage is marked once, the first time it happens (a reply spoken in pieces marks its first piece's stages). The turn
 * ends once: at its first audio, or without one (no reply, stopped, failed, too late). It then writes one
 * `voice_turn_latency` line, an EMF metric line, with each stage's time since the end of speech.
 *
 * Times are the node's clock (`clock().now()`), as the segmenter's are.
 */

/** In order: where each stage ends. `speechEnd` (the last loud packet) is the origin. */
export const TURN_STAGES = ["turnCommit", "transcript", "delivered", "llmFirstToken", "firstPiece", "ttsFirstAudio", "firstPacket"] as const;
export type TurnStage = typeof TURN_STAGES[number];
/**
 * How the reply came: the session spoke the agent's reply (`agent_reply`), a prompt's `speak` did (`prompt_speak`), or
 * the app asked to speak (`speak`, POST …/speak) soon after the transcript went out.
 */
export type TurnPath = "agent_reply" | "prompt_speak" | "speak";
/** spoken: its first audio went out. Otherwise why not. */
export type TurnOutcome = "spoken" | "no_reply" | "interrupted" | "error" | "empty";

/** Each stage's metric: ms from the end of speech. */
const METRICS: Record<TurnStage, string> = {
  turnCommit: "VoiceTurnCommitMs", transcript: "VoiceTranscriptMs", delivered: "VoiceDeliveredMs", llmFirstToken: "VoiceLlmFirstTokenMs",
  firstPiece: "VoiceFirstPieceMs", ttsFirstAudio: "VoiceTtsFirstAudioMs", firstPacket: "VoiceFirstPacketMs",
};

/**
 * What the line says of the turn. `ttsProvider`/`ttsModel` are who made its reply's first audio (through a chain of
 * providers, the member that served it, not the session's default), set by `spokenBy`.
 */
export type TurnInfo = { session: string; tenant: string; seq?: number; live?: boolean; sttModel?: string; ttsProvider?: string; ttsModel?: string };

export class TurnClock {
  readonly speechEnd: number;
  readonly marks: Partial<Record<TurnStage, number>> = {};
  readonly info: TurnInfo;
  path?: TurnPath;
  private outcome?: TurnOutcome;

  constructor(speechEnd: number, info: TurnInfo) {
    this.speechEnd = speechEnd;
    this.info = { ...info };
  }

  /** Whether the turn has ended (its line is written). */
  get ended() { return this.outcome !== undefined; }

  /** `stage` happened now (or `at`); a stage already marked keeps its first time. */
  mark(stage: TurnStage, at = clock().now()) {
    if (this.outcome === undefined) this.marks[stage] ??= at;
    return this;
  }

  /** The provider and model that made the reply's audio: the first piece's (a later piece's do not replace them). */
  spokenBy(provider: string, model: string) {
    if (this.outcome === undefined && this.info.ttsProvider === undefined) Object.assign(this.info, { ttsProvider: provider, ttsModel: model });
    return this;
  }

  /** How the reply came, the first time it is known. */
  via(path: TurnPath) {
    this.path ??= path;
    return this;
  }

  /** The turn ended: its first audio went out (`spoken`), or why not. Writes its line once. */
  end(outcome: TurnOutcome) {
    if (this.outcome !== undefined) return;
    this.outcome = outcome;
    writeMetricLine(turnLatencyLine(this, outcome));
  }

  /** Each marked stage, in ms since the end of speech. */
  stages(): Partial<Record<TurnStage, number>> {
    const out: Partial<Record<TurnStage, number>> = {};
    for (const stage of TURN_STAGES) {
      const at = this.marks[stage];
      if (at !== undefined) out[stage] = Math.max(0, Math.round(at - this.speechEnd));
    }
    return out;
  }
}

/**
 * The line a turn writes: each stage since the end of speech (`Voice<Stage>Ms`). For a spoken turn there are also the
 * stages' own lengths: STT (commit to transcript), the agent (transcript, or delivery, to first token), TTS (piece
 * queued to first audio) and playout (first audio to first packet). Published by Path, under ServiceName. Only a
 * spoken turn has VoiceFirstPacketMs, the headline: end of speech to first audio out.
 */
export function turnLatencyLine(turn: TurnClock, outcome: TurnOutcome) {
  const stages = turn.stages();
  const between = (from: TurnStage | undefined, to: TurnStage) => from !== undefined && stages[from] !== undefined && stages[to] !== undefined ? Math.max(0, stages[to]! - stages[from]!) : undefined;
  const ms = (value: number | undefined) => value === undefined ? undefined : [value, "Milliseconds"] as [number, "Milliseconds"];
  const metrics: Record<string, [number, "Milliseconds"] | number | undefined> = { VoiceTurns: 1 };
  for (const stage of TURN_STAGES) metrics[METRICS[stage]] = ms(stages[stage]);
  if (outcome === "spoken") {
    metrics.VoiceSttMs = ms(between("turnCommit", "transcript"));
    metrics.VoiceLlmMs = ms(between(stages.delivered !== undefined ? "delivered" : "transcript", "llmFirstToken"));
    metrics.VoiceTtsMs = ms(between("firstPiece", "ttsFirstAudio"));
    metrics.VoicePlayoutMs = ms(between("ttsFirstAudio", "firstPacket"));
  } else metrics.VoiceFirstPacketMs = undefined;
  const { session, tenant, seq, live, sttModel, ttsProvider, ttsModel } = turn.info;
  return metricLine("voice_turn_latency", {
    dimensions: { Path: turn.path ?? "none" }, rollups: [[], ["Path"]], metrics,
    properties: {
      session, tenant, outcome, ...(seq !== undefined ? { seq } : {}), ...(live !== undefined ? { live } : {}),
      ...(sttModel ? { sttModel } : {}), ...(ttsProvider ? { ttsProvider } : {}), ...(ttsModel ? { ttsModel } : {}), stagesMs: stages,
    },
  });
}

/**
 * Turns waiting for their reply from outside the session: the app's (POST …/speak, Path `speak`) or a prompt's
 * (`speak`, Path `prompt_speak`). A speaking session's latest transcript waits `waitMs` (30 s); the next speech asked
 * for in that session takes it, and one nobody takes (or a newer one replaces) ends `no_reply`. Sessions that do not
 * speak time no turns.
 */
export class WaitingTurns {
  private readonly waiting = new Map<string, { turn: TurnClock; timer: ReturnType<typeof setTimeout> }>();
  private readonly waitMs: number;

  constructor(waitMs = 30_000) { this.waitMs = waitMs; }

  /** The session's latest turn waits for its reply (one before it, still waiting, ends: a newer one replaced it). */
  wait(session: string, turn: TurnClock) {
    this.take(session)?.end("no_reply");
    const timer = setTimeout(() => {
      if (this.waiting.get(session)?.turn !== turn) return;
      this.waiting.delete(session);
      turn.end("no_reply");
    }, this.waitMs);
    timer.unref?.();
    this.waiting.set(session, { turn, timer });
  }

  /** The turn a speech in this session replies to, if one is waiting. */
  take(session: string): TurnClock | undefined {
    const waiting = this.waiting.get(session);
    if (!waiting) return undefined;
    this.waiting.delete(session);
    clearTimeout(waiting.timer);
    return waiting.turn;
  }

  /** Whether `turn` is waiting. */
  holds(turn: TurnClock) {
    for (const waiting of this.waiting.values()) if (waiting.turn === turn) return true;
    return false;
  }

  /** The session ended or moved: what waits is let go, unpublished. */
  forget(session: string) {
    const waiting = this.waiting.get(session);
    if (!waiting) return;
    this.waiting.delete(session);
    clearTimeout(waiting.timer);
  }

  get size() { return this.waiting.size; }
}
