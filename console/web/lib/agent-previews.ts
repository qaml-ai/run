import { useEffect, useRef, useState } from "react";
import { parseMarkdown, type Block, type Inline } from "@camelai/run/markdown";
import { api, type AgentSummary } from "./api";

export function previewText(markdown: string): string {
  const inline = (parts: Inline[]): string => parts.map(part => "children" in part ? inline(part.children) : part.type === "image" ? part.alt : "text" in part ? part.text : " ").join("");
  const blocks = (parts: Block[]): string => parts.map(part => "children" in part ? Array.isArray(part.children) && part.type === "blockquote" ? blocks(part.children) : inline(part.children as Inline[]) : part.type === "list" ? part.items.map(blocks).join(" ") : part.type === "table" ? [...part.head, ...part.rows.flat()].map(inline).join(" ") : part.type === "code" ? part.text : "").join(" ");
  return blocks(parseMarkdown(markdown)).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
}

/** One page-level cache: read a preview only on first sight or when the list's last activity changes.
 * Four concurrent reads at most; cards never fetch or poll. Pending counts come from the inbox. */
export function useAgentPreviews(agents: AgentSummary[]) {
  const cache = useRef(new Map<string, { activity: number | null | undefined; text: string }>());
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const key = agents.map(agent => `${agent.id}:${agent.lastActiveAt}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const pending = agents.filter(agent => !cache.current.has(agent.id) || cache.current.get(agent.id)?.activity !== agent.lastActiveAt);
    const run = async () => {
      while (pending.length && !cancelled) {
        const agent = pending.shift()!;
        try {
          const history = await api<{ entries: { message: { role: string; content: string | { type: string; text?: string }[] } }[] }>(`/v1/agents/${agent.id}/history?limit=6&maxBytes=16384`);
          const last = history.entries?.map(entry => entry.message).filter(message => message.role === "assistant" || message.role === "user").at(-1);
          const text = last ? previewText(typeof last.content === "string" ? last.content : last.content.filter(part => part.type === "text").map(part => part.text).join(" ")) : "";
          if (!cancelled) { cache.current.set(agent.id, { activity: agent.lastActiveAt, text }); setPreviews(current => ({ ...current, [agent.id]: text })); }
        } catch { if (!cancelled) setPreviews(current => ({ ...current, [agent.id]: "Could not load last message" })); }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, run));
    return () => { cancelled = true; };
  }, [key]);
  return previews;
}
