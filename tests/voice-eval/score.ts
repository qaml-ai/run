import { ANSWER_WAIT_MS, type PipelineRun, type ScenarioRun, type TurnRun, type UtteranceRun } from "./harness.ts";

/**
 * The voice eval's scores, from what a run heard and played (harness.ts), against each scenario's ground truth.
 *
 * - **Response latency**: an addressed turn's speech end (its last speech frame) to the bot's first audio packet
 *   answering it. p50/p95 over the answered turns. Its stages (named as camelRun's voice_turn_latency line names
 *   them, each ms after the speech end): turnCommitMs (the cut: transcription asked), transcriptMs (the text),
 *   deliveredMs (the app has it: webhook in, or the agent's prompt), llmFirstTokenMs, ttsFirstAudioMs, firstPacketMs.
 * - **Missed turns**: addressed turns the bot did not answer within ANSWER_WAIT_MS of their end.
 * - **Premature answers**: answers to part of a turn (cut at a pause), or started before the turn ended.
 * - **Wrong-addressee replies**: answers to turns not meant for the bot.
 * - **False cuts**: extra utterances a turn was cut into (at a pause inside it); **merged**: utterances holding more than
 *   one turn.
 * - **Talking over**: the bot's audio playing over a person's speech for more than TALK_OVER_MS (in one stretch).
 * - **Answer gaps**: silences longer than GAP_MS between the sentences of one answer (a streamed answer is spoken a
 *   sentence at a time, each its own speech), not counting where someone cut in.
 * - **Barge-in**: an interruption's speech start to the bot's last packet (`bargeInStopMs`); interruptions it talked
 *   through (`missedBargeIns`); backchannels and chatter that stopped it (`falseBargeIns`).
 * - **Transcript accuracy**: word error rate of each speaker's utterances against what they said (words, case and
 *   punctuation folded). With fake providers it counts only words lost or split by cuts.
 */

export const TALK_OVER_MS = 500;
export const GAP_MS = 300;

export type Stages = { turnCommitMs: number; transcriptMs: number; deliveredMs: number; llmFirstTokenMs: number; ttsFirstAudioMs: number; firstPacketMs: number };
export type Answer = { scenario: string; turn: number; text: string; stages: Partial<Stages> & { firstPacketMs: number } };
export type Score = {
  turns: number; addressed: number; answered: number;
  latency: { p50: number | null; p95: number | null; max: number | null };
  stages: Record<keyof Stages, { p50: number | null; p95: number | null }>;
  missedTurns: number; prematureAnswers: number; wrongAddressee: number; falseCuts: number; merged: number;
  talkingOver: number;
  /** Silences inside an answer (between its sentences, each made as its own speech) longer than GAP_MS: how many, and how long (p50). */
  answerGaps: number; answerGapMs: number | null;
  bargeIns: number; missedBargeIns: number; falseBargeIns: number; bargeInStopMs: { p50: number | null; max: number | null };
  wer: number | null; errors: number;
};

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]!);
}

const normal = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);

/** Word edit distance (substitutions, insertions, deletions). */
export function editDistance(reference: string[], hypothesis: string[]): number {
  let row = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i++) {
    const next = [i];
    for (let j = 1; j <= hypothesis.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
    row = next;
  }
  return row[hypothesis.length]!;
}

/** The utterances holding frames of a turn. */
const utterancesOf = (run: ScenarioRun, turn: TurnRun) => run.utterances.filter(u => u.frames.has(turn.id));
const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

export type ScenarioScore = Score & { name: string; answers: Answer[]; notes: string[] };

export function scoreScenario(run: ScenarioRun): ScenarioScore {
  const notes: string[] = [];
  const answers: Answer[] = [];
  const firstPlayback = (u: UtteranceRun) => run.playbacks.filter(p => p.tag === u.id && p.firstAt !== undefined).sort((a, b) => a.firstAt! - b.firstAt!)[0];
  let missed = 0, premature = 0, wrong = 0, falseCuts = 0, merged = 0;
  for (const turn of run.turns) {
    const pieces = utterancesOf(run, turn);
    if (pieces.length > 1) { falseCuts += pieces.length - 1; notes.push(`turn ${turn.index + 1} cut into ${pieces.length}`); }
    const replies = pieces.flatMap(u => { const p = firstPlayback(u); return p ? [{ u, p }] : []; }).sort((a, b) => a.p.firstAt! - b.p.firstAt!);
    const end = turn.endAt ?? 0;
    if (turn.turn.addressed) {
      // An answer to a part of the turn (its last frames not in the utterance answered): the bot did not hear it out.
      const last = Math.max(...pieces.flatMap(u => u.frames.get(turn.id) ?? []));
      const partial = replies.filter(r => !(r.u.frames.get(turn.id) ?? []).includes(last) || r.p.firstAt! < end);
      if (partial.length) { premature++; notes.push(`turn ${turn.index + 1} answered before it was heard out`); }
      const reply = replies.find(r => r.p.firstAt! >= end && r.p.firstAt! - end <= ANSWER_WAIT_MS);
      if (!reply) { missed++; notes.push(`turn ${turn.index + 1} not answered`); continue; }
      const { u, p } = reply;
      const at = (time?: number) => time === undefined ? undefined : time - end;
      answers.push({
        scenario: run.scenario.name, turn: turn.index + 1, text: turn.turn.text,
        stages: {
          turnCommitMs: at(u.calledAt), transcriptMs: at(u.doneAt), deliveredMs: at(u.deliveredAt), llmFirstTokenMs: at(u.llmFirstTokenAt),
          ttsFirstAudioMs: at(u.ttsFirstAudioAt), firstPacketMs: p.firstAt! - end,
        } as Answer["stages"],
      });
    } else if (replies.length) { wrong++; notes.push(`turn ${turn.index + 1} (not for the bot) answered`); }
  }
  for (const u of run.utterances) if (u.frames.size > 1) { merged++; notes.push(`utterance ${u.id} holds ${u.frames.size} turns`); }

  // Gaps inside an answer: from one of its speeches' last packet to the next one's first, when nobody stopped it.
  const gaps: number[] = [];
  const byTag = new Map<string, typeof run.playbacks>();
  for (const playback of run.playbacks) if (playback.tag && playback.firstAt !== undefined) (byTag.get(playback.tag) ?? byTag.set(playback.tag, []).get(playback.tag)!).push(playback);
  for (const playbacks of byTag.values()) {
    const sorted = playbacks.sort((a, b) => a.firstAt! - b.firstAt!);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1]!.stopped) continue;
      const gap = sorted[i]!.firstAt! - (sorted[i - 1]!.lastAt ?? sorted[i - 1]!.firstAt!) - 20;
      if (gap > GAP_MS) gaps.push(gap);
    }
  }

  // Talking over: a playback over one stretch of someone's speech for more than TALK_OVER_MS.
  let talkingOver = 0;
  const speech = run.turns.flatMap(turn => turn.segments.map(segment => ({ turn, segment })));
  for (const playback of run.playbacks) {
    if (playback.firstAt === undefined) continue;
    const span: [number, number] = [playback.firstAt, (playback.lastAt ?? playback.firstAt) + 20];
    for (const { turn, segment } of speech) {
      if (overlap(span, segment) > TALK_OVER_MS) { talkingOver++; notes.push(`talked over turn ${turn.index + 1}`); break; }
    }
  }

  // Barge-in: turns that start while the bot is answering (playing a sentence, or making the next one).
  let bargeIns = 0, missedBargeIns = 0, falseBargeIns = 0;
  const stops: number[] = [];
  const answersByTag = new Map<string, typeof run.playbacks>();
  for (const playback of run.playbacks) if (playback.tag) (answersByTag.get(playback.tag) ?? answersByTag.set(playback.tag, []).get(playback.tag)!).push(playback);
  for (const turn of run.turns) {
    const start = turn.startAt;
    if (start === undefined) continue;
    for (const playbacks of answersByTag.values()) {
      const first = Math.min(...playbacks.map(p => p.firstAt ?? Infinity));
      if (!(first < start)) continue;
      const active = playbacks.some(p => p.askedAt <= start && (p.endedAt ?? Infinity) + 40 >= start);
      const stopped = playbacks.find(p => p.stoppedAt !== undefined && p.stoppedAt >= start - 40 && p.stoppedAt <= start + 1_000);
      if (!active && !stopped) continue;
      const talkedOn = playbacks.some(p => (p.lastAt ?? 0) > start + 1_000);
      const cut = !!stopped && !talkedOn;
      if (turn.turn.interrupts) {
        bargeIns++;
        if (cut) stops.push(Math.max(0, stopped!.stoppedAt! - start));
        else { missedBargeIns++; notes.push(`talked through interruption ${turn.index + 1}`); }
      } else if (cut) { falseBargeIns++; notes.push(`stopped by ${turn.turn.kind} ${turn.index + 1}`); }
      break;
    }
  }

  // Each speaker's words against what was heard.
  let edits = 0, total = 0;
  for (const speaker of run.scenario.speakers) {
    const reference = run.turns.filter(turn => turn.turn.speaker === speaker.id).flatMap(turn => normal(turn.turn.text));
    const hypothesis = run.utterances.filter(u => u.speaker === speaker.id).sort((a, b) => a.calledAt - b.calledAt).flatMap(u => normal(u.text ?? ""));
    edits += editDistance(reference, hypothesis);
    total += reference.length;
  }
  const latencies = answers.map(answer => answer.stages.firstPacketMs);
  return {
    name: run.scenario.name, answers, notes: [...notes, ...run.errors],
    turns: run.turns.length, addressed: run.turns.filter(turn => turn.turn.addressed).length, answered: answers.length,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    stages: stageStats(answers),
    missedTurns: missed, prematureAnswers: premature, wrongAddressee: wrong, falseCuts, merged,
    talkingOver, answerGaps: gaps.length, answerGapMs: percentile(gaps, 50), bargeIns, missedBargeIns, falseBargeIns, bargeInStopMs: { p50: percentile(stops, 50), max: stops.length ? Math.max(...stops) : null },
    wer: total ? Math.round(edits / total * 1000) / 1000 : null, errors: run.errors.length,
  };
}

const STAGES: (keyof Stages)[] = ["turnCommitMs", "transcriptMs", "deliveredMs", "llmFirstTokenMs", "ttsFirstAudioMs", "firstPacketMs"];
function stageStats(answers: Answer[]): Score["stages"] {
  return Object.fromEntries(STAGES.map(stage => {
    const values = answers.flatMap(answer => answer.stages[stage] === undefined ? [] : [answer.stages[stage]!]);
    return [stage, { p50: percentile(values, 50), p95: percentile(values, 95) }];
  })) as Score["stages"];
}

export type PipelineScore = Score & { pipeline: string; description: string; profile: string; providers: string; scenarios: ScenarioScore[]; logs: Record<string, number> };

export function scorePipeline(run: PipelineRun): PipelineScore {
  const scenarios = run.scenarios.map(scoreScenario);
  const answers = scenarios.flatMap(scenario => scenario.answers);
  const latencies = answers.map(answer => answer.stages.firstPacketMs);
  const sum = (key: keyof Score) => scenarios.reduce((total, scenario) => total + (scenario[key] as number), 0);
  const stops = scenarios.flatMap(scenario => scenario.bargeInStopMs.p50 === null ? [] : [scenario.bargeInStopMs.p50]);
  const words = run.scenarios.reduce((total, scenario) => total + scenario.turns.reduce((n, turn) => n + turn.turn.text.split(/\s+/).length, 0), 0);
  const wer = scenarios.reduce((total, scenario, i) => total + (scenario.wer ?? 0) * run.scenarios[i]!.turns.reduce((n, turn) => n + turn.turn.text.split(/\s+/).length, 0), 0) / (words || 1);
  return {
    pipeline: run.pipeline.name, description: run.pipeline.description, profile: run.profile.name, providers: run.providers, scenarios, logs: run.logs,
    turns: sum("turns"), addressed: sum("addressed"), answered: sum("answered"),
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    stages: stageStats(answers),
    missedTurns: sum("missedTurns"), prematureAnswers: sum("prematureAnswers"), wrongAddressee: sum("wrongAddressee"), falseCuts: sum("falseCuts"), merged: sum("merged"),
    talkingOver: sum("talkingOver"), answerGaps: sum("answerGaps"),
    answerGapMs: percentile(scenarios.flatMap(scenario => scenario.answerGapMs === null ? [] : [scenario.answerGapMs]), 50), bargeIns: sum("bargeIns"), missedBargeIns: sum("missedBargeIns"), falseBargeIns: sum("falseBargeIns"),
    bargeInStopMs: { p50: percentile(stops, 50), max: stops.length ? Math.max(...stops) : null },
    wer: Math.round(wer * 1000) / 1000, errors: sum("errors"),
  };
}

const ms = (value: number | null) => value === null ? "-" : `${value}`;

/** The scoreboard as Markdown: one row per pipeline, then each pipeline's scenarios and its latency stages. */
export function scoreboard(scores: PipelineScore[]): string {
  const lines = [
    `Voice eval: ${scores[0]?.providers ?? "fake"} providers, profile ${scores[0]?.profile ?? "-"}. Latency is speech end to the bot's first audio (ms).`,
    "",
    "| pipeline | latency p50 | p95 | answered | missed | premature | wrong addressee | false cuts | merged | talking over | answer gaps (p50 ms) | barge-in stop p50 | missed barge-ins | false barge-ins | WER |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...scores.map(s => `| ${s.pipeline} | ${ms(s.latency.p50)} | ${ms(s.latency.p95)} | ${s.answered}/${s.addressed} | ${s.missedTurns} | ${s.prematureAnswers} | ${s.wrongAddressee} | ${s.falseCuts} | ${s.merged} | ${s.talkingOver} | ${s.answerGaps} (${ms(s.answerGapMs)}) | ${ms(s.bargeInStopMs.p50)} | ${s.missedBargeIns} | ${s.falseBargeIns} | ${s.wer ?? "-"} |`),
    "",
    "Latency stages, p50 (p95), ms after speech end:",
    "",
    "| pipeline | turnCommitMs | transcriptMs | deliveredMs | llmFirstTokenMs | ttsFirstAudioMs | firstPacketMs |",
    "|---|---|---|---|---|---|---|",
    ...scores.map(s => `| ${s.pipeline} | ${STAGES.map(stage => `${ms(s.stages[stage].p50)} (${ms(s.stages[stage].p95)})`).join(" | ")} |`),
  ];
  for (const s of scores) {
    lines.push("", `${s.pipeline} (${s.description}), by scenario:`, "",
      "| scenario | p50 | p95 | answered | missed | premature | wrong | cuts | over | gaps | false barge-ins | WER | notes |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...s.scenarios.map(c => `| ${c.name} | ${ms(c.latency.p50)} | ${ms(c.latency.p95)} | ${c.answered}/${c.addressed} | ${c.missedTurns} | ${c.prematureAnswers} | ${c.wrongAddressee} | ${c.falseCuts} | ${c.talkingOver} | ${c.answerGaps} | ${c.falseBargeIns} | ${c.wer ?? "-"} | ${c.notes.slice(0, 4).join("; ")} |`));
    const failures = Object.entries(s.logs).filter(([type]) => /failed|error|dropped/.test(type));
    if (failures.length) lines.push("", `Pipeline failures logged: ${failures.map(([type, n]) => `${type} ${n}`).join(", ")}`);
  }
  return lines.join("\n");
}
