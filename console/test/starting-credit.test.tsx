import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StartingCreditHelp } from "../web/components/starting-credit";

afterEach(cleanup);

it("hides the card offer and button when billing does not offer a card check", () => {
  render(<StartingCreditHelp credit={{ status: "not_granted", amount: 0 }} action />);
  expect(screen.queryByRole("button", { name: "Verify a card" })).toBeNull();
  expect(screen.queryByText(/Verify a card to get/)).toBeNull();
  expect(screen.getByText(/Add credit to start running agents/)).toBeTruthy();
});

it("shows the amount offered by billing instead of a fixed $5", () => {
  render(<StartingCreditHelp credit={{ status: "not_granted", amount: 0, cardCheck: { amount: 1_250_000 } }} action />);
  expect(screen.getByText(/Verify a card to get \$1.25/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Verify a card" })).toBeTruthy();
});
