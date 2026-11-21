import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

/** Paths are relative to /console/, e.g. "agents/agt_abc". */
const BASE = "/console/";
const current = () => (location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length).replace(/\/+$/, "") : "");

export function navigate(to: string, { replace = false }: { replace?: boolean } = {}) {
  const url = BASE + to;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}

function useLocationPart<T>(read: () => T) {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    update();
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return value;
}

export const usePath = () => useLocationPart(current);
export const useSearch = () => useLocationPart(() => location.search);

export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...props}
      href={BASE + to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
