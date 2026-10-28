import { test } from "node:test";
import assert from "node:assert/strict";
import { languageInput, languageInstructions, languageName } from "../src/language.ts";
import { Agents } from "../clients/node.ts";
import { OPERATOR, runtime, until } from "./runtime-server.ts";

/** The system text a chat-completions request carried. */
const system = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text).join("")).join("\n\n");
const count = (text: string, part: string) => text.split(part).length - 1;
const SPANISH = "Language: reply in Spanish (español) by default. If the person clearly writes in another language, reply in that language instead.";

test("a language is a BCP 47 tag in canonical form, named in English and in itself; junk is refused", () => {
  for (const [given, tag] of [["en", "en"], ["es", "es"], ["es-ES", "es-ES"], ["pt-br", "pt-BR"], ["zh-hant", "zh-Hant"], ["zh-TW", "zh-TW"], ["es-419", "es-419"], ["EN-us", "en-US"]]) {
    assert.equal(languageInput(given), tag, given);
  }
  assert.equal(languageInput(null), null);
  for (const junk of ["", "e", "zz", "qaa", "english", "en_US", "en--US", "x-private", "i-klingon", "es-ES-", "a".repeat(36), "es-ES-valencia-xxxxxxxxxxxxxxxxxxxxx", 5, true, {}]) {
    assert.throws(() => languageInput(junk), /language must be a BCP 47 language tag/, JSON.stringify(junk));
  }
  assert.equal(languageName("es"), "Spanish (español)");
  assert.equal(languageName("en"), "English");
  assert.equal(languageName("pt-BR"), "Brazilian Portuguese (português (Brasil))");
  assert.equal(languageInstructions("es"), SPANISH);
  // The same text every time: nothing per turn in it.
  assert.equal(languageInstructions("es"), languageInstructions("es"));
});

test("an agent's language: in its prompt once and the same every turn, shown, changed and cleared by PATCH, refused when junk", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const configure = async (agent: string, body: object) => {
    const accepted = await r.call(`/v1/agents/${agent}/configuration`, { method: "PATCH", body });
    if (accepted.status !== 202) return accepted;
    return { status: 202, json: await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json; return record.state === "completed" && record; }, "the configuration") };
  };

  const refused = await r.call("/v1/agents", { body: { systemPrompt: "Be brief.", language: "klingon!" } });
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.json.error, /language/);
  assert.equal((await r.call("/v1/agents", { body: { language: "a".repeat(36) } })).status, 400);

  const made = await r.call("/v1/agents", { body: { systemPrompt: "Be brief.", language: "es" } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  assert.equal((await r.call(`/v1/agents/${id}`)).json.language, "es");
  await r.prompt(id, "Hello");
  await r.prompt(id, "Again");
  const [first, second] = r.model.bodies.slice(-2).map(system);
  assert.equal(count(first, SPANISH), 1, first);
  assert.equal(first, second, "the system prompt is the same text on every turn");
  assert.ok(first.indexOf("Be brief.") < first.indexOf(SPANISH), "after the application's instructions");

  // Without a language there is no such line.
  const plain = (await r.call("/v1/agents", { body: { systemPrompt: "Be brief." } })).json.id;
  await r.prompt(plain, "Hello");
  assert.equal(count(system(r.model.bodies.at(-1)), "Language:"), 0);
  assert.equal((await r.call(`/v1/agents/${plain}`)).json.language, null);

  // PATCH: junk is refused at once; a new language replaces it; null clears it.
  assert.equal((await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { language: "not a tag" } })).status, 400);
  const changed = await configure(id, { language: "pt-br" });
  assert.equal(changed.json.outcome?.error, undefined, JSON.stringify(changed.json));
  assert.equal((await r.call(`/v1/agents/${id}`)).json.language, "pt-BR");
  await r.prompt(id, "Olá");
  await r.prompt(id, "De novo");
  const [third, fourth] = r.model.bodies.slice(-2).map(system);
  assert.equal(count(third, languageInstructions("pt-BR")), 1, third);
  assert.equal(count(third, "Language:"), 1, "the new language replaces the old one");
  assert.equal(third, fourth);
  const cleared = await configure(id, { language: null });
  assert.equal(cleared.json.outcome?.error, undefined, JSON.stringify(cleared.json));
  assert.equal((await r.call(`/v1/agents/${id}`)).json.language, null);
  await r.prompt(id, "Hi");
  const last = system(r.model.bodies.at(-1));
  assert.equal(count(last, languageInstructions("pt-BR")), 0, last);
  assert.equal(count(last, SPANISH), 0, last);

  // A new agent made with a language and later cleared starts from a prompt without it.
  const fresh = (await r.call("/v1/agents", { body: { systemPrompt: "Be brief.", language: "fr" } })).json.id;
  await configure(fresh, { language: null });
  await r.prompt(fresh, "Bonjour");
  assert.equal(count(system(r.model.bodies.at(-1)), "Language:"), 0);

  // An upsert with another language is another configuration, and brings the agent to it.
  const a = await r.call("/v1/agents", { body: { language: "es" }, headers: { "Idempotency-Key": "language-upsert" } });
  const same = await r.call("/v1/agents", { body: { language: "es" }, headers: { "Idempotency-Key": "language-upsert" } });
  const other = await r.call("/v1/agents", { body: { language: "de" }, headers: { "Idempotency-Key": "language-upsert" } });
  assert.equal(a.json.configHash, same.json.configHash);
  assert.notEqual(a.json.configHash, other.json.configHash);
  await until(async () => (await r.call(`/v1/agents/${a.json.id}/requests/${other.json.reconfigured.id}`)).json.state === "completed", "the upsert");
  assert.equal((await r.call(`/v1/agents/${a.json.id}`)).json.language, "de");
});

test("a definition's language: its agents inherit it, an agent's own stays when it is applied, and a run takes its own or the definition's", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  assert.equal((await r.call("/v1/definitions", { body: { name: "junk", language: "zz" } })).status, 400);
  const definition = (await r.call("/v1/definitions", { body: { name: "helper", systemPrompt: "Help.", language: "es-es" } })).json;
  assert.equal(definition.language, "es-ES");
  const inherits = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const own = (await r.call("/v1/agents", { body: { definition: definition.id, language: "fr" } })).json.id;
  assert.equal((await r.call(`/v1/agents/${inherits}`)).json.language, "es-ES");
  assert.equal((await r.call(`/v1/agents/${own}`)).json.language, "fr");
  await r.prompt(inherits, "Hi");
  assert.equal(count(system(r.model.bodies.at(-1)), languageInstructions("es-ES")), 1);
  await r.prompt(own, "Hi");
  assert.equal(count(system(r.model.bodies.at(-1)), languageInstructions("fr")), 1);

  const applied = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { language: "de", apply: "all" } });
  assert.equal(applied.status, 200, applied.text);
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((entry: any) => entry.revision === 2), "the apply");
  assert.deepEqual(await Promise.all([inherits, own].map(async id => (await r.call(`/v1/agents/${id}`)).json.language)), ["de", "fr"]);
  // A revision without a language clears it from agents that took the definition's.
  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { language: null, apply: "all" } });
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json.every((entry: any) => entry.revision === 3), "the apply");
  assert.deepEqual(await Promise.all([inherits, own].map(async id => (await r.call(`/v1/agents/${id}`)).json.language)), [null, "fr"]);

  // Stateless runs: their own language, or their definition's, which their own overrides.
  const run = await r.call("/v1/runs", { body: { input: "Hi", systemPrompt: "Help.", language: "ja", wait: true } });
  assert.equal(run.json.status, "completed", run.text);
  assert.equal(count(system(r.model.bodies.at(-1)), languageInstructions("ja")), 1);
  await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { language: "it" } });
  await r.call("/v1/runs", { body: { input: "Hi", definition: definition.id, wait: true } });
  assert.equal(count(system(r.model.bodies.at(-1)), languageInstructions("it")), 1);
  await r.call("/v1/runs", { body: { input: "Hi", definition: definition.id, language: "ko", wait: true } });
  const overridden = system(r.model.bodies.at(-1));
  assert.equal(count(overridden, languageInstructions("ko")), 1);
  assert.equal(count(overridden, "Language:"), 1);
  assert.equal((await r.call("/v1/runs", { body: { input: "Hi", language: "nope nope" } })).status, 400);
});

test("the TypeScript SDK sends language when it makes, configures and runs agents", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert("language", { instructions: "Be brief.", language: "es" });
  await agent.run("hola");
  assert.equal(count(system(r.model.bodies.at(-1)), SPANISH), 1);
  await agent.configure({ language: null });
  await agent.run("hi");
  assert.equal(count(system(r.model.bodies.at(-1)), "Language:"), 0);
  await agents.run({ instructions: "Be brief.", input: "once", language: "de" });
  assert.equal(count(system(r.model.bodies.at(-1)), languageInstructions("de")), 1);
});
