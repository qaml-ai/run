### The computer tool works with OpenAI and Azure models

On the Workers backend, a model served by OpenAI or Azure refused every request of an agent that had the `computer` tool: "Invalid schema for function 'computer': schema must be a JSON Schema of 'type: "object"'". The tool's arguments were declared as a choice between shapes, one per operation, and those APIs take only a single object. The tool now declares one object: `provider`, `op`, and the optional `command`, `argv`, `timeoutMs`, `path`, `content`, `format` and `name`, each saying which operation takes it. The limits are unchanged. A call whose fields do not fit its operation is refused before it reaches the computer, saying why: "exec needs command or argv", "write needs content", "sleep does not take command".

Tests on both backends now check that every tool a model can be given declares a top-level object. No other tool needed changing.
