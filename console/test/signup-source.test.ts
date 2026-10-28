import { describe, expect, it } from "vitest";
import { signupSource } from "../web/lib/signup-source";

const ORIGIN = "https://run.example.test";

describe("where a sign-up came from", () => {
  it("is the link's ref and the host of the site the browser came from", () => {
    expect(signupSource("?ref=run-slack", "https://camelai.com/", ORIGIN)).toEqual({ ref: "run-slack", from: "camelai.com" });
    expect(signupSource("", "https://www.google.com/", ORIGIN)).toEqual({ from: "www.google.com" });
    expect(signupSource("?start=code&ref=home", "", ORIGIN)).toEqual({ ref: "home" });
    expect(signupSource("", "", ORIGIN)).toEqual({});
  });

  it("is not the console itself, nor the provider a failed sign-in came back from", () => {
    expect(signupSource("", `${ORIGIN}/console/agents`, ORIGIN)).toEqual({});
    expect(signupSource("?error=Sign-in%20failed", "https://github.com/", ORIGIN)).toEqual({});
    // The runtime's own pages that are not the console (its docs) are a site the browser came from.
    expect(signupSource("", `${ORIGIN}/docs/quickstart`, ORIGIN)).toEqual({ from: "run.example.test" });
    expect(signupSource("", "android-app://com.slack/", ORIGIN)).toEqual({});
  });
});
