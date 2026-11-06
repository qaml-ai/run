import { startFixture } from "./fixture.ts";
const parsed = new URL(process.env.AGENT_DATABASE_URL!);
const schema = parsed.searchParams
  .get("options")
  ?.replace("-c search_path=", "");
const fixture = await startFixture({
  schema,
  token: process.env.AGENT_SESSION_SECRET,
  tenant: "python",
  modelURL: process.env.AGENT_BASE_URL,
  vars: {
    MODEL: `${process.env.AGENT_PROVIDER ?? "openrouter"}/${process.env.AGENT_MODEL ?? "openai/gpt-4o-mini"}`,
    ...(process.env.AGENT_IMAGES_URL || process.env.AGENT_TRANSCRIPTION_URL
      ? {
          MEDIA_BASE_URL:
            process.env.AGENT_IMAGES_URL ??
            process.env.AGENT_TRANSCRIPTION_URL!,
        }
      : {}),
  },
});
console.log(
  JSON.stringify({ address: { port: Number(new URL(fixture.url).port) } }),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void fixture.stop().finally(() => process.exit(0));
  });
await new Promise(() => {});
