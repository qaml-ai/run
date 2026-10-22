import { useCallback, useEffect, useMemo } from "react";
import { api, useApi, type Workspace, type WorkspaceMembership } from "@/lib/api";
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

/** Dispatched on window after workspaces or assignments change, so every view of them (the switcher, lists) reloads. */
export const WORKSPACES_CHANGED = "console:workspaces-changed";
export type WorkspaceKind = "agent" | "definition";

/**
 * The account's workspaces and who is in them, joined on the client (the list endpoints don't carry a workspace yet).
 * `workspaceOf` is a resource's workspace id, or null when unassigned; `inScope` answers for the switcher's selection.
 */
export function useWorkspaceDirectory() {
  const workspaces = useApi<Workspace[]>("/v1/workspaces");
  const memberships = useApi<WorkspaceMembership[]>("/v1/workspace-memberships");
  const { reload: reloadWorkspaces } = workspaces, { reload: reloadMemberships } = memberships;
  useEffect(() => {
    const reload = () => { void reloadWorkspaces(); void reloadMemberships(); };
    addEventListener(WORKSPACES_CHANGED, reload);
    return () => removeEventListener(WORKSPACES_CHANGED, reload);
  }, [reloadWorkspaces, reloadMemberships]);
  // Anything but a list (an older runtime without workspaces) reads as none.
  const list = workspaces.data && (Array.isArray(workspaces.data) ? workspaces.data : []);
  const members = memberships.data && (Array.isArray(memberships.data) ? memberships.data : []);
  const assigned = useMemo(() => new Map(members?.map(member => [`${member.kind}:${member.id}`, member.workspaceId])), [members]);
  const workspaceOf = useCallback((kind: WorkspaceKind, id: string) => assigned.get(`${kind}:${id}`) ?? null, [assigned]);
  const inScope = useCallback((kind: WorkspaceKind, id: string, ws: string | undefined) =>
    ws === undefined || (ws === UNASSIGNED ? workspaceOf(kind, id) === null : workspaceOf(kind, id) === ws), [workspaceOf]);
  return {
    workspaces: list, loaded: !!list && !!members, error: workspaces.error ?? memberships.error,
    workspaceOf, inScope,
    find: (id: string | null | undefined) => id ? list?.find(workspace => workspace.id === id) : undefined,
    /** Where a workspace sits on the swatch ramp: its place in the account's list. */
    index: (id: string) => list?.findIndex(workspace => workspace.id === id) ?? -1,
  };
}
export type WorkspaceDirectory = ReturnType<typeof useWorkspaceDirectory>;

/** Assign resources to a workspace (null: unassign), a few at a time; earlier spend keeps its attribution. Tells every view after. */
export async function moveToWorkspace(kind: WorkspaceKind, ids: string[], workspaceId: string | null) {
  try {
    for (let at = 0; at < ids.length; at += 6) {
      await Promise.all(ids.slice(at, at + 6).map(id => api(`/v1/workspace-memberships/${kind}/${id}`, { method: "PUT", body: { workspaceId } })));
    }
  } finally {
    dispatchEvent(new Event(WORKSPACES_CHANGED));
  }
}

/** Create, rename, archive or restore a workspace, and tell every view. */
export async function changeWorkspaces<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } finally { dispatchEvent(new Event(WORKSPACES_CHANGED)); }
}
