import assert from "node:assert/strict";
import test from "node:test";
import { selectAgentTools } from "../src/file-tool-selection.ts";

test("native computer tools require a configured provider and enabled codemode", () => {
  const tools = ["computer", "exec", "host_execute", "codemode", "computer_exec", "browser_click", "lookup"].map(name => ({ name }));
  const selected = (bindings: string[], config = {}) => {
    const selection = selectAgentTools(tools, new Set(), config, new Set(),
      Object.fromEntries(bindings.map(name => [name, {}])));
    return {
      tools: selection.tools.map(tool => tool.name),
      modelTools: selection.modelTools.map(tool => tool.name),
    };
  };
  const ordinary = { tools: ["codemode", "lookup"], modelTools: ["codemode", "lookup"] };
  assert.deepEqual(selected([]), ordinary, "an unconfigured native tool stays hidden");
  const native = { tools: ["computer", "codemode", "lookup"], modelTools: ["computer", "codemode", "lookup"] };
  for (const bindings of [["COMPUTER_CONTAINERS"], ["COMPUTER_SANDBOXES"], ["COMPUTER_CONTAINERS", "COMPUTER_SANDBOXES"]]) {
    assert.deepEqual(selected(bindings), native, "either configured native provider enables the registered tool");
    assert.deepEqual(selected(bindings, { codeMode: false }), { tools: ["lookup"], modelTools: ["lookup"] }, "disabling codemode also hides the native tool");
  }
});
