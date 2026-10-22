import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { isScoped } from "@/lib/nav";

/** Paths are relative to /console/, e.g. "agents/client_abc". */
const BASE = "/console/";
const current = () => location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length).replace(/\/+$/, "") : "";

/**
 * The selected workspace lives in `?ws=` on the pages the switcher scopes (absent means all workspaces). Links between
 * those pages carry it; account pages drop it, and the browser remembers it so the way back restores it.
 */
const WORKSPACE_KEY = "console.workspace";
let remembered: string | undefined;
export function rememberedWorkspace(): string | undefined {
  try { return localStorage.getItem(WORKSPACE_KEY) ?? undefined; } catch { return remembered; }
}
export function rememberWorkspace(ws: string | undefined) {
  remembered = ws;
  try { if (ws) localStorage.setItem(WORKSPACE_KEY, ws); else localStorage.removeItem(WORKSPACE_KEY); } catch { /* storage blocked: kept for this page only */ }
}

/** The workspace the current URL selects: its `?ws=` on a scoped page; the remembered one elsewhere. */
export function currentWorkspace(): string | undefined {
  return isScoped(current().split("/")[0]) ? new URLSearchParams(location.search).get("ws") || undefined : rememberedWorkspace();
}

/** `to` as it should be visited from here: a scoped page that names no workspace gets the selected one; `ws=` (empty) means all. */
export function resolve(to: string): string {
  const hashAt = to.indexOf("#");
  const hash = hashAt < 0 ? "" : to.slice(hashAt);
  const [path, query = ""] = (hashAt < 0 ? to : to.slice(0, hashAt)).split("?");
  if (!isScoped(path.split("/")[0])) return to;
  const params = new URLSearchParams(query);
  if (!params.has("ws")) { const ws = currentWorkspace(); if (!ws) return to; params.set("ws", ws); }
  else if (!params.get("ws")) params.delete("ws");
  const search = params.toString();
  return `${path}${search ? `?${search}` : ""}${hash}`;
}

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  const url = BASE + resolve(to);
  if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}

function useLocationPart<T>(read: () => T) {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return value;
}

export const usePath = () => useLocationPart(current);
/** `location.search`, kept current across navigation. */
export const useSearch = () => useLocationPart(() => location.search);

export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return <a {...props} href={BASE + resolve(to)} onClick={(event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  }} />;
}
