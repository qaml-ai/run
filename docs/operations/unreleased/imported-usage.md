### Imported history

- Fix: an imported assistant message without `usage` (which the guide says is optional) could fail the agent's next
  run ("Cannot read properties of undefined (reading 'totalTokens')"). Imported messages now get what they leave out:
  a timestamp, an assistant message's `usage` (zero) and `stopReason` (`toolUse` when it calls tools), a tool
  result's `isError` (false).
