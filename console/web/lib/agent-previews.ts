import { useEffect, useRef, useState } from "react";
import { parseMarkdown, type Block, type Inline } from "@camelai/run/markdown";
import { api, type AgentSummary, type StoredMessage } from "./api";

export function previewText(markdown: string): string {
  const inline = (parts: Inline[]): string =>
    parts.map(part => ("children" in part ? inline(part.children) : part.type === "image" ? part.alt : "text" in part ? part.text : " ")).join("");
  const blocks = (parts: Block[]): string =>
    parts
      .map(part =>
        "children" in part
          ? Array.isArray(part.children) && part.type === "blockquote"
            ? blocks(part.children)
            : inline(part.children as Inline[])
          : part.type === "list"
            ? part.items.map(blocks).join(" ")
            : part.type === "table"
              ? [...part.head, ...part.rows.flat()].map(inline).join(" ")
              : part.type === "code"
                ? part.text
                : "",
      )
      .join(" ");
  return blocks(parseMarkdown(markdown)).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
}

/** One page-level cache: read the latest message preview from GET /v2/agents/:id/history?before=latest&limit=6. */
export function useAgentPreviews(agents: AgentSummary[]) {
  const cache = useRef(new Map<string, { activity: number; text: string }>());
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const key = agents.map(agent => `${agent.id}:${agent.updatedAt}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const pending = agents.filter(agent => !cache.current.has(agent.id) || cache.current.get(agent.id)?.activity !== agent.updatedAt);
    const run = async () => {
      while (pending.length && !cancelled) {
        const agent = pending.shift()!;
        try {
          const history = await api<{ messages: StoredMessage[] }>(`/v2/agents/${encodeURIComponent(agent.id)}/history?before=latest&limit=6`);
          const last = (history.messages ?? [])
            .filter(message => (message.role === "assistant" || message.role === "user") && typeof message.content?.text === "string" && message.content.text.trim())
            .at(-1);
          const text = last?.content?.text ? previewText(last.content.text) : "";
          if (!cancelled) {
            cache.current.set(agent.id, { activity: agent.updatedAt, text });
            setPreviews(current => ({ ...current, [agent.id]: text }));
          }
        } catch {
          if (!cancelled) setPreviews(current => ({ ...current, [agent.id]: "" }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, run));
    return () => { cancelled = true; };
  }, [key]);
  return previews;
}
