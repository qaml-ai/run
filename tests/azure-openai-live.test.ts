import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { azureCredentials, azureOpenAIConfig } from "../src/azure-openai.ts";
import { imageHeader } from "../src/image-header.ts";
import { checkedImage, imageOptions, openaiImages, OUTPUT_TOKENS } from "../src/images.ts";
import { checkedAudio, openaiTranscription } from "../src/transcription.ts";
import { Outbound } from "../src/outbound.ts";

// A real low-quality image, an edit of it and a transcription on the platform's Azure OpenAI deployments, each timed
// beside OpenAI's when OPENAI_API_KEY is set too: about $0.03. Runs only with AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY set.
const azure = process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY
  ? azureOpenAIConfig({ endpoint: process.env.AZURE_OPENAI_ENDPOINT, apiKey: process.env.AZURE_OPENAI_API_KEY }, "AZURE_OPENAI_*") : undefined;
const openai = process.env.OPENAI_API_KEY;
const timed = async <T>(work: () => Promise<T>) => { const started = Date.now(); const value = await work(); return { value, ms: Date.now() - started }; };

test("Azure OpenAI makes and edits an image with its gpt-image-2.5-flare deployment, billing the tokens OpenAI does", { skip: !azure && "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are not set" }, async () => {
  const provider = openaiImages({ outbound: new Outbound() });
  const signal = AbortSignal.timeout(180_000);
  const options = imageOptions({ quality: "low" });
  const credentials = azureCredentials(azure!, azure!.imageDeployment!, { apiKey: "" });
  const made = await timed(() => provider.generate({ prompt: "A small flat icon of a camel", images: [], options }, credentials, signal));
  assert.deepEqual(imageHeader(Buffer.from(made.value.images[0]!.bytes)), { mimeType: "image/png", width: 1024, height: 1024 });
  assert.equal(made.value.tokens.output, OUTPUT_TOKENS["1024x1024"].low);
  assert.equal(made.value.model, "gpt-image-2.5-flare");
  const edited = await timed(() => provider.generate({ prompt: "Make the camel blue", images: [checkedImage(made.value.images[0]!.bytes)], options }, credentials, signal));
  assert.equal(edited.value.tokens.imageInput, 1024);
  const compared = openai ? await timed(() => provider.generate({ prompt: "A small flat icon of a camel", images: [], options }, { apiKey: openai }, signal)) : undefined;
  console.log(JSON.stringify({ type: "azure_image_latency", azureMs: made.ms, azureEditMs: edited.ms, ...(compared ? { openaiMs: compared.ms, openaiTokens: compared.value.tokens } : {}), azureTokens: made.value.tokens }));
});

test("Azure OpenAI transcribes a voice note with its gpt-transcribe deployment", { skip: !azure && "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are not set" }, async () => {
  const bytes = readFileSync(new URL("./fixtures/audio/hello.ogg", import.meta.url));
  const provider = openaiTranscription({ outbound: new Outbound() });
  const audio = { bytes, header: checkedAudio(bytes) };
  const signal = AbortSignal.timeout(60_000);
  const heard = await timed(() => provider.transcribe(audio, {}, azureCredentials(azure!, azure!.transcriptionDeployment!, { apiKey: "" }), signal));
  assert.match(heard.value.text, /hello from .*short test of speech[ -]to[ -]text/i);
  assert.deepEqual([heard.value.model, heard.value.language, heard.value.seconds], ["gpt-transcribe", "en", 5]);
  const compared = openai ? await timed(() => provider.transcribe(audio, {}, { apiKey: openai }, signal)) : undefined;
  console.log(JSON.stringify({ type: "azure_transcription_latency", azureMs: heard.ms, azureText: heard.value.text, ...(compared ? { openaiMs: compared.ms, openaiText: compared.value.text } : {}) }));
});
