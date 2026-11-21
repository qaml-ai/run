import { accountLabel, type Me } from "@/lib/api";

/** Who is signed in: their name and Google address or GitHub login when sign-in gave them, never a sign-in account's id. */
export function SignedInAs({ me }: { me: Pick<Me, "tenant" | "login" | "name"> }) {
  const who = me.name ?? me.login ?? accountLabel(me.tenant) ?? "Your account";
  const detail = me.name && me.login;
  return <>
    <span aria-hidden="true" className="border-sidebar-border bg-sidebar-accent flex size-8 shrink-0 items-center justify-center border text-sm font-medium">
      {who[0]?.toUpperCase() ?? "?"}
    </span>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium" title={who}>{who}</div>
      {detail && <div className="text-muted-foreground truncate text-xs" title={detail}>{detail}</div>}
    </div>
  </>;
}
