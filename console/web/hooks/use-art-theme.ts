import { useSyncExternalStore } from "react";

type ArtTheme = "dark" | "light";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const snapshot = (): ArtTheme => document.documentElement.classList.contains("dark") ? "dark" : "light";

/**
 * The theme for dither art: the `dark` class main.tsx keeps on <html>, so the
 * canvas always matches the tokens around it and repaints when the OS switches.
 */
export function useArtTheme(): ArtTheme {
  return useSyncExternalStore(subscribe, snapshot);
}
