import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SignedInAs } from "../web/components/signed-in-as";

afterEach(cleanup);

describe("SignedInAs", () => {
  it("names the person, with their address under their name, and never the sign-in account's id", () => {
    const { container } = render(<SignedInAs me={{ tenant: "u-4f2a9c1d7e3b6a58", login: "ada@example.com", name: "Ada Lovelace" }} />);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(container.textContent).not.toContain("u-4f2a9c1d7e3b6a58");
  });

  it("shows the address or login alone when there is no name", () => {
    const { container } = render(<SignedInAs me={{ tenant: "octocat", login: "octocat" }} />);
    expect(container.textContent).toBe("Ooctocat");
  });

  it("falls back to an admin tenant's id, but not to a sign-in account's", () => {
    expect(render(<SignedInAs me={{ tenant: "acme" }} />).container.textContent).toContain("acme");
    cleanup();
    const { container } = render(<SignedInAs me={{ tenant: "u-4f2a9c1d7e3b6a58" }} />);
    expect(container.textContent).toContain("Your account");
    expect(container.textContent).not.toContain("u-4f2a");
  });
});
