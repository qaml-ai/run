// Copied from voice/realtime/brain.ts:71-111,1141-1186 and voice-sessions.ts:1746-1768.
import type { RealtimeTool } from "../realtime/provider.ts";

export const ASK_AGENT: RealtimeTool = {
  name: "ask_agent",
  description: "Ask the bot's agent: the bot's brain, with its tools, data, memory and knowledge, and it can act. Call it for anything beyond small talk: facts, anything current or about this server and its people, look-ups, and anything someone asks the bot to do. Never answer those yourself. As you call it, say a short filler in character (\"one sec, let me check\"). When its reply comes, say it in your own words, briefly and naturally, as if you knew it.",
  parameters: { type: "object", properties: { request: { type: "string", description: "The request, self-contained: who asked, what they want in their words, and any detail from the call it needs" } }, required: ["request"] },
};
export const STAY_SILENT: RealtimeTool = {
  name: "stay_silent",
  description: "Say nothing this turn: what was said was not for you (people talking to each other, a remark to someone else), or needs no answer. Call it instead of speaking.",
  parameters: { type: "object", properties: {} },
};

/** The rules every realtime brain's instructions carry, after the bot's persona. */
export function realtimeInstructions(persona: string | undefined, options: { agent: boolean; group: boolean; forYouFirst?: boolean }) {
  // Before the rules that send it to ask_agent, for a model that otherwise answers people talking to each other.
  const forYouFirst = options.group && options.forYouFirst;
  return [
    persona?.trim() ? persona.trim() : "You are a friendly, helpful voice assistant.",
    "",
    "You are speaking in a live voice call. How it works:",
    "- Before each person's speech there is a note naming who speaks, like \"[Ana]\". Several people may be in the call; use their names when it helps.",
    "- Talk like a person in a call: short, natural sentences (one to three unless asked for more). No lists, markdown, code or links.",
    ...forYouFirst ? [`- People in a call mostly talk to each other. Unless what was said names you, follows up on what you just said, or comes from the only person talking, it is not for you, even if it is a question: call stay_silent and say nothing.${options.agent ? " The rules below are for what is for you." : ""}`] : [],
    ...options.agent ? [
      "- You are the bot's voice; its agent is its brain. The agent has the bot's tools, data and memory, and does the real work. You only talk.",
      "- Call ask_agent for anything beyond small talk: questions of fact, anything current (news, weather, prices, scores, dates), anything about this server, its people or the bot's own data and features, anything someone asks you to do, and anything you are not sure of. When in doubt, ask it.",
      "- Never answer those from your own knowledge, never make up what the agent would know, and never say you cannot do something without asking it first.",
      "- As you call it, say a short filler in character (\"one sec, let me check\"), then wait. When its reply comes, say it in your own words, briefly. If it failed or is still working, say so plainly.",
    ] : [],
    ...options.group && !forYouFirst ? ["- If what was said was not meant for you (people talking to each other), call stay_silent and say nothing."] : [],
    "- If someone talks over you, you were cut off at that point: do not repeat what you already said unless asked.",
  ].join("\n");
}
export const askPrompt = (request: string, name?: string) =>
  `[A request from your voice in a live voice call${name ? `, asked by ${name}` : ""}. Do what it needs with your tools first; then answer in one to three plain spoken sentences (no markdown, lists, links or emoji), since your reply is read aloud]\n${request}`;

export const PENDING = "The agent is still working on it. Say it is taking a moment and you will tell them when it is done.";
export const EMPTY_REPLY = "(The agent did this, and wrote nothing back.)";
export const EMPTY_REQUEST = "ask_agent needs a request: call it again with what to ask the agent.";
export const ASK_FAILED = "The agent could not do it just now.";

export const lateReply = (request: string, said: string) => `[The agent's late reply to "${request.slice(0, 300)}"]\n${said}`;
export const lateFailure = (request: string) => `[The agent could not finish "${request.slice(0, 300)}"]`;
export const LATE_REPLY = "The agent's reply to an earlier request just came in (the last note): tell them now, briefly, in your own words.";
export const LATE_FAILURE = "The agent could not finish an earlier request (the last note): say so briefly.";
