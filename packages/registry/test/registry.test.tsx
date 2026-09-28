import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { projectMessages } from "@camelai/agent-runtime/chat";
import { AgentProvider } from "@camelai/agent-runtime-react";
import { AgentChatView } from "../src/agent-chat/agent-chat.tsx";
import { fakeChat } from "../../react/test/fake-chat.ts";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe("the shadcn registry", () => {
  it("is built from the sources (run packages/registry/build.ts after changing them)", () => {
    execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", at("../build.ts"), "--check"]);
    const item = JSON.parse(readFileSync(at("../public/r/agent-chat.json"), "utf8"));
    expect(item.name).toBe("agent-chat");
    expect(item.dependencies).toContain("@camelai/agent-runtime-react");
    expect(item.files.map((file: { target: string }) => file.target)).toEqual(["components/agent-chat/agent-chat.tsx", "components/agent-chat/agent-parts.tsx", "components/agent-chat/agent-markdown.tsx"]);
    for (const file of item.files) expect(file.content.length).toBeGreaterThan(100);
  });

  it("its chat renders a conversation, answers, and sends", async () => {
    const fake = fakeChat();
    render(<AgentProvider chat={fake.chat}><AgentChatView suggestions={["Hi there"]} /></AgentProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Hi there" }));
    expect(fake.chat.send).toHaveBeenCalledWith("Hi there");
    const question = { id: "inp_1", toolCallId: "c1", kind: "approval", message: "Allow delete?", answering: false, detail: { arguments: "{}" } } as any;
    const messages = projectMessages({
      messages: [
        { role: "user", content: "go", timestamp: 1 } as any,
        { role: "assistant", content: [{ type: "text", text: "Sure, **deleting**." }, { type: "toolCall", id: "c1", name: "delete", arguments: {} }], stopReason: "toolUse", timestamp: 2 } as any,
        { role: "toolResult", toolCallId: "c1", toolName: "delete", content: [], isError: false, details: { inputRequired: true }, timestamp: 3 } as any,
      ],
      indexes: [0, 1, 2], partial: null, running: false, inputs: [question],
    });
    act(() => fake.set({ messages, inputs: [question], status: "input_required" }));
    expect(screen.getByText("deleting").tagName).toBe("STRONG");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(fake.chat.answer).toHaveBeenCalledWith(question, true);
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "thanks{Enter}");
    expect(fake.chat.send).toHaveBeenCalledWith("thanks");
  });
});
