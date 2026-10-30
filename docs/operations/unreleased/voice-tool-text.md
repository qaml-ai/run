### ElevenLabs voice no longer reads a written-out tool call aloud

Everything the ElevenLabs Agents LLM writes goes to its text to speech. A generation that writes a tool call out as text
(`tool_code`, `print(default_api.…)`) is now not played or kept as the bot's words from that point on, and logs
`voice_realtime_warning` with `errorCode: tool_text_not_spoken` (no text). New agents, `camelRun realtime voice v4`, set
`thinking_budget: 0` and send `agent_chat_response_part`; they are made as each key's next call connects.
