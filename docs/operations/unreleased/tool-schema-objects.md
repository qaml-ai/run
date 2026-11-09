### Computer tools work with OpenAI and Azure models

The Workers `computer` tool now declares one object schema, so OpenAI-family models accept its tool list. Operation-specific fields are checked before execution with the same limits. Regression checks cover runtime and hosted MCP tool schemas on both backends.
