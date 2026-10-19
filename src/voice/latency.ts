import { clock } from "../node-context.ts";
import { metricLine, writeMetricLine } from "../metrics.ts";

/**
 * How long a voice turn takes, stage by stage: from the end of someone's speech to the first audio of the realtime
 * brain's answer (docs/operations/voice-pipeline.md, "Latency instrumentation"). One `TurnClock` follows one turn. Each
 * stage is marked once, the first time it happens. The turn ends once: at its first audio, or without one (no answer,
 * stopped, failed, too late). It then writes one `voice_turn_latency` line, an EMF metric line, with each stage's time
 * since the end of speech.
 *
 * Times are the node's clock (`clock().now()`), as the segmenter's are.
 */

/** In order: where each stage ends. `speechEnd` (the last loud packet) is the origin. */
export const TURN_STAGES = ["turnCommit", "ttsFirstAudio", "firstPacket"] as const;
export type TurnStage = typeof TURN_STAGES[number];
/** How the answer came: the realtime brain (the only one, kept as the metric's Path dimension). */
export type TurnPath = "realtime";
/** spoken: its first audio went out. Otherwise why not (silent: a realtime brain chose not to answer, stay_silent). */
export type TurnOutcome = "spoken" | "no_reply" | "interrupted" | "error" | "silent";

/** Each stage's metric: ms from the end of speech. */
const METRICS: Record<TurnStage, string> = { turnCommit: "VoiceTurnCommitMs", ttsFirstAudio: "VoiceTtsFirstAudioMs", firstPacket: "VoiceFirstPacketMs" };

/** What the line says of the turn: who made its answer's audio (the realtime provider and model). */
export type TurnInfo = {
  session: string; tenant: string; ttsProvider?: string; ttsModel?: string;
  /** Its response began at likely_end (`speculative`), and it asked the agent (`askAgent`). */
  speculative?: boolean; askAgent?: boolean;
};

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
 * stages' own lengths: the model (the turn's commit, or its confirmation for a response begun early, to its first
 * audio) and playout (first audio to first packet). Published by Path, under ServiceName. Only a spoken turn has
 * VoiceFirstPacketMs, the headline: end of speech to first audio out.
 */
export function turnLatencyLine(turn: TurnClock, outcome: TurnOutcome) {
  const stages = turn.stages();
  const between = (from: TurnStage | undefined, to: TurnStage) => from !== undefined && stages[from] !== undefined && stages[to] !== undefined ? Math.max(0, stages[to]! - stages[from]!) : undefined;
  const ms = (value: number | undefined) => value === undefined ? undefined : [value, "Milliseconds"] as [number, "Milliseconds"];
  const metrics: Record<string, [number, "Milliseconds"] | number | undefined> = { VoiceTurns: 1 };
  for (const stage of TURN_STAGES) metrics[METRICS[stage]] = ms(stages[stage]);
  if (outcome === "spoken") {
    metrics.VoiceRealtimeMs = ms(between("turnCommit", "ttsFirstAudio"));
    metrics.VoicePlayoutMs = ms(between("ttsFirstAudio", "firstPacket"));
  } else metrics.VoiceFirstPacketMs = undefined;
  const { session, tenant, ttsProvider, ttsModel, speculative, askAgent } = turn.info;
  return metricLine("voice_turn_latency", {
    dimensions: { Path: turn.path ?? "none" }, rollups: [[], ["Path"]], metrics,
    properties: {
      session, tenant, outcome, ...(ttsProvider ? { ttsProvider } : {}), ...(ttsModel ? { ttsModel } : {}),
      ...(speculative !== undefined ? { speculative } : {}), ...(askAgent ? { askAgent } : {}), stagesMs: stages,
    },
  });
}
