import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TierSection } from "../web/pages/billing";

afterEach(cleanup);

describe("TierSection", () => {
  it("shows the tier, its busy-agent limit, and what the next tier takes", () => {
    const { container } = render(<TierSection busy={{ busy: 3, limit: 25, source: "tier", tier: "Tier 1", paid: 20_000_000, next: { tier: "Tier 2", paid: 50_000_000, limit: 100 } }} />);
    expect(container.textContent).toContain("Tier 1");
    expect(container.textContent).toContain("Up to 25 agents busy at once · 3 busy now");
    expect(container.textContent).toMatch(/Tier 2 \(100 busy agents\) once you've paid \$50\.00 in total for credit; \$30\.00 to go/);
  });

  it("says when the tier is the highest, and when the limit is set for the account", () => {
    expect(render(<TierSection busy={{ limit: 1000, source: "tier", tier: "Tier 4", paid: 1_200_000_000 }} />).container.textContent).toContain("The highest tier");
    cleanup();
    const { container } = render(<TierSection busy={{ busy: 0, limit: 200, source: "tenant" }} />);
    expect(container.textContent).toContain("Custom");
    expect(container.textContent).toContain("Set for this account");
  });
});
