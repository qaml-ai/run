import { useCallback, useEffect } from "react";
import { isScoped } from "@/lib/nav";
import { currentWorkspace, navigate, rememberWorkspace, usePath, useSearch } from "@/lib/router";

/** `?ws=unassigned` selects agents and definitions in no workspace (and spend attributed to none). */
export const UNASSIGNED = "unassigned";

/**
 * The workspace the switcher selects: a workspace id, `UNASSIGNED`, or undefined for all workspaces. Scoped pages read
 * it to filter; pages that can't filter yet ignore it.
 */
export function useWorkspace() {
  const path = usePath();
  const search = useSearch();
  const [section, id] = path.split("/");
  const scoped = isScoped(section);
  const ws = scoped ? new URLSearchParams(search).get("ws") || undefined : currentWorkspace();
  // The last choice made on a scoped page is the one the way back from an account page restores.
  useEffect(() => { if (scoped) rememberWorkspace(ws); }, [scoped, ws]);

  /** Select `next`: a scoped page stays where it is (a detail page goes to its list); an account page goes home. */
  const setWorkspace = useCallback((next: string | undefined) => {
    rememberWorkspace(next);
    const query = new URLSearchParams(scoped ? search : "");
    query.set("ws", next ?? "");
    const page = !scoped ? ""
      : section === "workspaces" ? (next && next !== UNASSIGNED ? `workspaces/${next}` : "workspaces")
      : section;
    navigate(`${page}?${query}`);
  }, [scoped, search, section]);

  /** Forget a selection the account doesn't have (a deleted workspace, or another account's in this browser), in place. */
  const forgetWorkspace = useCallback(() => {
    rememberWorkspace(undefined);
    if (!scoped || !ws) return;
    const query = new URLSearchParams(search);
    query.set("ws", "");
    navigate(`${section === "workspaces" && id ? "workspaces" : path}?${query}`, { replace: true });
  }, [scoped, ws, search, section, id, path]);

  return { ws, scoped, setWorkspace, forgetWorkspace };
}
