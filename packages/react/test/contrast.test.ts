// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The theme's variables, per theme, as styles.css declares them. */
function themes() {
  const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
  const block = (selector: RegExp) => Object.fromEntries([...css.match(selector)![1].matchAll(/--agent-([a-z-]+):\s*(#[0-9a-f]{6})/g)].map(match => [match[1], match[2]]));
  return { light: block(/:where\(\.agent-chat\) \{([^}]*)\}/), dark: { ...block(/:where\(\.agent-chat\) \{([^}]*)\}/), ...block(/:where\(\.agent-chat\[data-theme="dark"\]\) \{([^}]*)\}/) } };
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe("the default themes", () => {
  it("meet WCAG AA contrast (4.5:1) for every text color on the backgrounds it is drawn on", () => {
    const pairs: [string, string][] = [["fg", "bg"], ["muted-fg", "bg"], ["muted-fg", "muted"], ["fg", "user-bg"], ["fg", "code-bg"], ["accent-fg", "accent"], ["danger", "bg"]];
    for (const [name, theme] of Object.entries(themes())) {
      for (const [text, background] of pairs) {
        const ratio = contrast(theme[text], theme[background]);
        expect(ratio, `${name}: --agent-${text} on --agent-${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
