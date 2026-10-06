import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TierSection } from "../web/pages/billing";

afterEach(cleanup);

describe("TierSection", () => {
  it("shows the tier, its busy-agent limit, and what the next tier takes", () => {
    const { container } = render(<TierSection busy={{ busy: 3, limit: 25, source: "tier", tier: "Tier 1", paid: 20_000_000, next: { tier: "Tier 2", paid: 50_000_000, limit: 100 } }} />);
    expect(container.textContent).toContain("Tier 1");
    expect(container.textContent).toContain("Up to 25 agents busy at once · 3 busy now");
    expect(container.textContent).toMatch(/\$30\.00 more of credit unlocks Tier 2: 100 busy agents \(once you've paid \$50\.00 in total for credit\)/);
  });

  it("says the run limit, and on free credit what buying credit raises it to", () => {
    const busy = { busy: 0, limit: 20, source: "tier" as const, tier: "Free", paid: 0, next: { tier: "Tier 1", paid: 5_000_000, limit: 25 } };
    const { container } = render(<TierSection busy={busy} runs={{ limit: 240, afterPurchase: 600 }} />);
    expect(container.textContent).toContain("$5.00 more of credit unlocks Tier 1: 25 busy agents");
    expect(container.textContent).toContain("Up to 240 runs started a minute; buying credit raises it to 600");
    expect(container.textContent).toContain("Creating agents is limited only against abuse");
  });

  it("says when the tier is the highest, and when the limit is set for the account", () => {
    expect(render(<TierSection busy={{ limit: 1000, source: "tier", tier: "Tier 4", paid: 1_200_000_000 }} />).container.textContent).toContain("The highest tier");
    cleanup();
    const { container } = render(<TierSection busy={{ busy: 0, limit: 200, source: "tenant" }} />);
    expect(container.textContent).toContain("Custom");
    expect(container.textContent).toContain("Set for this account");
  });
});
