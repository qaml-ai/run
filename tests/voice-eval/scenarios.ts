/**
 * The voice eval's scripted calls. Each is a Discord voice channel with a bot called Mochi and a few people. Every turn
 * says who speaks, what they say, when, and whether the bot should answer (`addressed`): the ground truth the scores
 * are measured against.
 *
 * - `text` is what is said; "|" marks a pause inside the turn (`pausesMs`, one per "|"): someone thinking mid-sentence.
 * - `start`: `{at}` ms from the call's start; `{gap}` ms after the previous turn's speech ended (negative: they talk over
 *   it); `{afterBot}` ms after the bot stops answering the previous turn (or 8 s after it, if the bot never answers);
 *   `{intoBot}` ms after the bot starts answering the previous turn (an interruption, a backchannel).
 * - `interrupts`: the speaker means to stop the bot (true for an interruption). A backchannel ("mm-hm") does not.
 * - `reply`: what the bot answers, when it answers (its model is faked: the same words every run).
 */

export type Start = { at: number } | { gap: number } | { afterBot: number } | { intoBot: number };
export type Turn = {
  speaker: string; text: string; start: Start; addressed: boolean;
  kind: "question" | "chatter" | "backchannel" | "interruption";
  pausesMs?: number[]; interrupts?: boolean; reply?: string; language?: string;
};
export type Speaker = { id: string; name: string; voice?: string; noiseDb?: number; openMic?: boolean };
export type Scenario = { name: string; description: string; speakers: Speaker[]; turns: Turn[]; language?: string };

export const BOT = { name: "Mochi", addressed: /\bmochi\b/i };

const ANA: Speaker = { id: "500000000000000001", name: "Ana", voice: "coral" };
const BEN: Speaker = { id: "500000000000000002", name: "Ben", voice: "onyx" };
const CHLOE: Speaker = { id: "500000000000000003", name: "Chloe", voice: "shimmer" };

const SHORT = "Sure. It's about twenty minutes by train from the center.";
const LONG = "Okay, here's the short version. The first step is to preheat the oven to two hundred degrees. Then you mix the flour, the butter and a pinch of salt until it looks like sand. After that, add cold water a spoon at a time and stop as soon as it holds together.";

export const SCENARIOS: Scenario[] = [
  {
    name: "qa-single",
    description: "One person asks the bot four questions, waiting for each answer",
    speakers: [ANA],
    turns: [
      { speaker: ANA.id, kind: "question", addressed: true, start: { at: 500 }, text: "Mochi, how far is the airport from here?", reply: SHORT },
      { speaker: ANA.id, kind: "question", addressed: true, start: { afterBot: 700 }, text: "Mochi, and is there a train at night?", reply: "Yes, the last one leaves just after midnight." },
      { speaker: ANA.id, kind: "question", addressed: true, start: { afterBot: 600 }, text: "Okay Mochi, what does a ticket cost?", reply: "About eleven euros one way." },
      { speaker: ANA.id, kind: "question", addressed: true, start: { afterBot: 900 }, text: "Thanks Mochi. Can I pay by card?", reply: "Yes, every machine takes cards." },
    ],
  },
  {
    name: "group-chatter",
    description: "Three friends talk among themselves; twice someone asks the bot",
    speakers: [ANA, BEN, CHLOE],
    turns: [
      { speaker: ANA.id, kind: "chatter", addressed: false, start: { at: 500 }, text: "Did you guys finish the level last night?" },
      { speaker: BEN.id, kind: "chatter", addressed: false, start: { gap: 400 }, text: "No, the boss at the end kept killing me." },
      { speaker: CHLOE.id, kind: "chatter", addressed: false, start: { gap: 300 }, text: "Same, I think you need the ice sword for it." },
      { speaker: BEN.id, kind: "question", addressed: true, start: { gap: 700 }, text: "Mochi, where do you get the ice sword?", reply: "It's in the frozen cave, behind the waterfall." },
      { speaker: ANA.id, kind: "chatter", addressed: false, start: { afterBot: 500 }, text: "Oh I've been there, it's really dark." },
      { speaker: CHLOE.id, kind: "chatter", addressed: false, start: { gap: -400 }, text: "Wait, which waterfall?" },
      { speaker: BEN.id, kind: "chatter", addressed: false, start: { gap: 500 }, text: "The big one near the village, I think." },
      { speaker: ANA.id, kind: "chatter", addressed: false, start: { gap: 600 }, text: "Let's all go after dinner then." },
      { speaker: CHLOE.id, kind: "question", addressed: true, start: { gap: 800 }, text: "Mochi, remind us at eight to play.", reply: "Okay, I'll remind you at eight." },
      { speaker: BEN.id, kind: "chatter", addressed: false, start: { afterBot: 400 }, text: "Nice, see you then." },
    ],
  },
  {
    name: "barge-in",
    description: "Someone cuts the bot off mid-answer with a new question",
    speakers: [ANA],
    turns: [
      { speaker: ANA.id, kind: "question", addressed: true, start: { at: 500 }, text: "Mochi, how do I make pie crust?", reply: LONG },
      { speaker: ANA.id, kind: "interruption", addressed: true, interrupts: true, start: { intoBot: 2_500 }, text: "Mochi, stop. How long does it bake?", reply: "About thirty minutes." },
      { speaker: ANA.id, kind: "question", addressed: true, start: { afterBot: 700 }, text: "Mochi, at what temperature?", reply: "Two hundred degrees." },
    ],
  },
  {
    name: "backchannel",
    description: "People say mm-hm and yeah while the bot talks, without meaning to stop it",
    speakers: [ANA, BEN],
    turns: [
      { speaker: ANA.id, kind: "question", addressed: true, start: { at: 500 }, text: "Mochi, explain how to make pie crust.", reply: LONG },
      { speaker: BEN.id, kind: "backchannel", addressed: false, interrupts: false, start: { intoBot: 1_500 }, text: "Mm-hm." },
      { speaker: ANA.id, kind: "backchannel", addressed: false, interrupts: false, start: { gap: 2_000 }, text: "Yeah." },
      { speaker: ANA.id, kind: "question", addressed: true, start: { afterBot: 800 }, text: "Mochi, can I use oil instead of butter?", reply: "You can, but it will be less flaky." },
    ],
  },
  {
    name: "thinking-pause",
    description: "Questions with pauses mid-sentence, as people think",
    speakers: [BEN],
    turns: [
      { speaker: BEN.id, kind: "question", addressed: true, start: { at: 500 }, pausesMs: [600], text: "Mochi, what's the capital of | Australia?", reply: "Canberra." },
      { speaker: BEN.id, kind: "question", addressed: true, start: { afterBot: 800 }, pausesMs: [1_000], text: "Mochi, can you tell me | how many people live there?", reply: "About four hundred and sixty thousand." },
      { speaker: BEN.id, kind: "question", addressed: true, start: { afterBot: 800 }, pausesMs: [400, 900], text: "And Mochi, is it | bigger than | Sydney?", reply: "No, Sydney is much bigger." },
    ],
  },
  {
    name: "non-english",
    description: "Questions in Spanish, Portuguese and French",
    speakers: [CHLOE, ANA],
    turns: [
      { speaker: CHLOE.id, kind: "question", addressed: true, language: "es", start: { at: 500 }, text: "Mochi, ¿qué hora es en Tokio ahora?", reply: "Son las tres de la mañana en Tokio." },
      { speaker: ANA.id, kind: "question", addressed: true, language: "pt", start: { afterBot: 700 }, text: "Mochi, qual é a melhor praia do Rio?", reply: "Muita gente prefere Ipanema." },
      { speaker: CHLOE.id, kind: "chatter", addressed: false, language: "fr", start: { afterBot: 500 }, text: "Je pense que Copacabana est plus belle." },
      { speaker: ANA.id, kind: "question", addressed: true, language: "fr", start: { gap: 700 }, text: "Mochi, tu peux nous dire une blague?", reply: "Pourquoi les plongeurs plongent-ils en arrière? Sinon ils tombent dans le bateau." },
    ],
  },
  {
    name: "noisy-open-mic",
    description: "A person with an open mic (always transmitting) and a loud fan behind them (above the quiet threshold)",
    speakers: [{ ...BEN, noiseDb: -35, openMic: true }, ANA],
    turns: [
      { speaker: BEN.id, kind: "question", addressed: true, start: { at: 500 }, text: "Mochi, what's the weather like tomorrow?", reply: "Sunny, with a high of twenty-four." },
      { speaker: ANA.id, kind: "question", addressed: true, start: { afterBot: 700 }, text: "Mochi, and on Sunday?", reply: "Rain in the afternoon." },
      { speaker: BEN.id, kind: "chatter", addressed: false, start: { afterBot: 600 }, text: "Ugh, I wanted to go hiking." },
    ],
  },
  {
    name: "quiet-open-mic",
    description: "An open mic with soft room noise (below the quiet threshold)",
    speakers: [{ ...CHLOE, noiseDb: -55, openMic: true }],
    turns: [
      { speaker: CHLOE.id, kind: "question", addressed: true, start: { at: 500 }, text: "Mochi, give me a word that rhymes with orange.", reply: "Nothing rhymes perfectly with orange, but door hinge comes close." },
      { speaker: CHLOE.id, kind: "question", addressed: true, start: { afterBot: 700 }, text: "Mochi, and with purple?", reply: "Hurple, if you're making words up." },
    ],
  },
  {
    name: "crosstalk",
    description: "Two people talk over each other while a third asks the bot",
    speakers: [ANA, BEN, CHLOE],
    turns: [
      { speaker: ANA.id, kind: "chatter", addressed: false, start: { at: 500 }, text: "I really think we should leave early tomorrow morning." },
      { speaker: BEN.id, kind: "chatter", addressed: false, start: { gap: -1_200 }, text: "No way, I'm not getting up at six again." },
      { speaker: CHLOE.id, kind: "question", addressed: true, start: { gap: -600 }, text: "Mochi, when does the ferry leave?", reply: "The first ferry is at seven thirty." },
      { speaker: ANA.id, kind: "chatter", addressed: false, start: { gap: -300 }, text: "See, seven thirty, we have to be early." },
      { speaker: BEN.id, kind: "chatter", addressed: false, start: { afterBot: 300 }, text: "Fine, but someone else drives." },
    ],
  },
];
