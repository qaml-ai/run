### Voice: realtime sessions on the platform's OpenAI key can run on Azure OpenAI

Operators with an Azure OpenAI resource (`AGENT_AZURE_OPENAI_*`) now send realtime voice sessions made on the
platform's OpenAI key to its `gpt-realtime-2.1` deployment (`realtimeDeployment` in the secret, or
`AGENT_AZURE_REALTIME_DEPLOYMENT`; default that name, `""` keeps voice on OpenAI; `realtimeModels` /
`AGENT_AZURE_REALTIME_MODELS` for other realtime models). A session connects to Azure's GA realtime endpoint with the
`api-key` header, its input transcription on the `gpt-transcribe` deployment. When Azure refuses or fails before the
session is live, it goes on on OpenAI with the platform's key (`voice_realtime_azure_fallback`). A tenant's own key
stays on OpenAI. Billing is unchanged. The `voice_realtime` metric gains a `Host` dimension (`azure` or `openai`) and
`VoiceRealtimeAzureFallbacks`. A secret stored before this change, without `realtimeDeployment`, sends voice to Azure's
`gpt-realtime-2.1` deployment once the new image runs: store `"realtimeDeployment": ""` first to keep it on OpenAI.
