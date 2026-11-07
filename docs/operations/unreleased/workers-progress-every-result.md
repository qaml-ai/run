### Workers: sub-agents' progress rides on every tool result

On the Workers backend, a background sub-agent's `report_progress` reached its parent's model only with the results of the multi-agent tools (`send_message`, `list_agents`, …). It now rides on the parent's next tool result whatever the tool, as on Node and as the multi-agent guide says. A lead busy with `computer` or MCP calls sees its workers' progress without calling a multi-agent tool. Codemode results and calls made from code carry none, and neither does an error result.
