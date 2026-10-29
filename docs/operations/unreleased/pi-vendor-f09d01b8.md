### Pi bumped to main f09d01b85e03 (can be rolled back)

The vendored Pi moves from `02a2b2532d8f` (2026-10-28) to `f09d01b85e03` (2026-10-29), versioned
`1.4.0-main.f09d01b85e03-camel.4`; our four patches apply unchanged (only their changelog context moved).

No stored document or task version changes (`pi.live`, `pi.tool`, `pi.generation` and the rest keep their versions)
and no change to the Postgres storage: this deploy can be rolled back.

What changes for the runtime:

- **Closing an agent is no longer read as a storage failure.** Pi now ends a commit observer `failed` ("session
  closed") when its Session closes, where it ended it `ended`. The agent gives itself up on a `failed` end, so without
  the adapter change every close (an idle unload, a hand-off) would have reported `Session persistence failed` and a
  handed-off turn would have failed instead. The adapter now ignores the end after its own close.
- **pi-ai**: a Zhipu/Z.ai plan usage limit (error code 1308, sent as HTTP 429) is no longer retried.
- Upstream's other changes are new APIs the runtime does not use (`StoreStorage` on Chord v2's store,
  `registryReader`, Chord v2 slices) and coding-agent/TUI changes outside the vendored packages.
- **OpenRouter DeepSeek V4.1 Flash still asks for at most 131,072 output tokens.** Pi's catalog moved its longest reply
  to 943,718, which OpenRouter would route only to hosts that serve that much (Nebius, one of its five allowed hosts,
  serves 943,200) and which, with a long input, asks for more than the 1M window holds. The runtime now caps it at
  131,072 as it does 1017 and Azure Flash, agents made before included.
- **Model catalog** (pi-ai's, generated when the commit was vendored): 7 OpenRouter/Vercel/Mistral models added, 1
  removed (`openrouter/upstage/solar-pro-3`), and list prices moved on some OpenRouter entries (V4.1 Flash, V4 Pro,
  Kimi K3, GLM). V4.1 Flash, Kimi K3 and GLM 5.3 keep our own prices (`src/pi-catalog.ts`), and OpenRouter calls are
  still billed what OpenRouter reports. The Anthropic, OpenAI, Google, Azure, Bedrock and DeepSeek entries are
  unchanged.
