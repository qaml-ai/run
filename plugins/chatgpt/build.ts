import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { tools } from "../../packages/cli/src/tools.ts";

/**
 * The camelRun plugin for ChatGPT and Codex: check plugin/ against the Agent Plugins schemas (schemas/, copied from
 * https://agent-plugins.org/schemas/1.0.0/) and the limits of OpenAI's directory submission
 * (https://developers.openai.com/plugins/deploy/submission-errors), then zip it for the Plugins dashboard.
 *
 *   node --experimental-strip-types plugins/chatgpt/build.ts          # writes plugins/chatgpt/dist/camelrun-<version>.zip
 *   node --experimental-strip-types plugins/chatgpt/build.ts --check  # checks only
 *
 * Errors stop the build. Warnings name what the dashboard still needs before the plugin can be submitted for review.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
export const PLUGIN_ROOT = join(here, "plugin");

const CATEGORIES = ["Productivity", "Creativity", "Developer Tools", "Business & Operations", "Data & Analytics", "Communication", "Education & Research", "Security", "Finance", "Healthcare", "Travel", "Entertainment", "Other"];
const SUBMISSION_URLS = ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"] as const;
const ICONS = ["logo", "logoDark", "composerIcon", "composerIconDark"] as const;
/** API tokens, OAuth tokens and the like: none may be in the ZIP. */
const SECRET = /\b(?:art|aro|arr|arc|sk|rk)_(?:live_|test_)?[A-Za-z0-9_-]{16,}/;

const oneLine = (value: unknown, max: number) => typeof value === "string" && value.trim() !== "" && !/[\n\r\t\u2028\u2029]/.test(value) && value.length <= max;
const https = (value: unknown) => { try { return typeof value === "string" && value.length <= 1024 && new URL(value).protocol === "https:" && !new URL(value).username; } catch { return false; } };

/** WCAG contrast of two #RRGGBB colors. */
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(file: string) {
  const bytes = readFileSync(file);
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

/** Everything wrong with the package in `root` (errors), and what submission still needs (warnings). */
export function validate(root = PLUGIN_ROOT) {
  const errors: string[] = [], warnings: string[] = [];
  const json = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));
  const manifest = json("plugin.json"), mcp = json("mcp.json");

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const [name, document] of [["plugin", manifest], ["mcp", mcp]] as const) {
    const check = ajv.compile(JSON.parse(readFileSync(join(here, "schemas", `${name}.schema.json`), "utf8")));
    if (!check(document)) errors.push(...check.errors!.map(error => `${name}.json${error.instancePath}: ${error.message}`));
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(manifest.name ?? "")) errors.push("name: at most 64 letters, digits, _ and -");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) errors.push("version: a semantic version");
  if (typeof manifest.description !== "string" || !manifest.description.trim() || manifest.description.length > 1024) errors.push("description: 1 to 1024 characters");
  if (!oneLine(manifest.author?.name, 120)) errors.push("author.name: required");

  const openai = manifest.extensions?.["com.openai"] ?? {};
  const ui = openai.interface ?? {};
  if (!oneLine(ui.displayName, 30)) errors.push("interface.displayName: one line, at most 30 characters");
  if (!oneLine(ui.shortDescription, 30)) errors.push("interface.shortDescription: one line, at most 30 characters");
  if (typeof ui.longDescription !== "string" || !ui.longDescription.trim() || ui.longDescription.length > 4000) errors.push("interface.longDescription: 1 to 4000 characters");
  if (!oneLine(ui.developerName, 80)) errors.push("interface.developerName: one line, at most 80 characters");
  if (!CATEGORIES.includes(ui.category)) errors.push(`interface.category: one of ${CATEGORIES.join(", ")}`);
  if (!Array.isArray(ui.capabilities) || ui.capabilities.length > 20 || !ui.capabilities.every((capability: unknown) => oneLine(capability, 120))) errors.push("interface.capabilities: at most 20, each one line of at most 120 characters");
  const prompts: unknown[] = Array.isArray(ui.defaultPrompt) ? ui.defaultPrompt : [ui.defaultPrompt];
  if (prompts.length > 3 || !prompts.every(prompt => oneLine(prompt, 128) && !String(prompt).includes("@")) || new Set(prompts.map(prompt => String(prompt).trim().toLowerCase().replace(/\s+/g, " "))).size !== prompts.length) {
    errors.push("interface.defaultPrompt: at most 3 unique one-line prompts of at most 128 characters, without @mentions");
  }
  for (const field of SUBMISSION_URLS) {
    if (ui[field] === undefined) warnings.push(`interface.${field} is missing: required to submit an MCP plugin for review`);
    else if (!https(ui[field])) errors.push(`interface.${field}: an https URL of at most 1024 characters`);
  }
  for (const [field, against] of [["brandColor", "#FFFFFF"], ["brandColorDark", "#212121"]] as const) {
    if (ui[field] === undefined) continue;
    if (!/^#[0-9A-Fa-f]{6}$/.test(ui[field])) errors.push(`interface.${field}: #RRGGBB`);
    else if (contrast(ui[field], against) < 2) errors.push(`interface.${field}: at least 2:1 contrast against ${against}`);
  }
  for (const field of ICONS) {
    const path = ui[field];
    if (path === undefined) { if (field === "logo" || field === "composerIcon") errors.push(`interface.${field}: required`); continue; }
    const file = resolve(root, path);
    if (!path.startsWith("./") || relative(root, file).startsWith("..")) { errors.push(`interface.${field}: a ./ path inside the plugin`); continue; }
    if (!existsSync(file)) { errors.push(`interface.${field}: ${path} does not exist`); continue; }
    const size = pngSize(file);
    if (!path.endsWith(".png") || !size) errors.push(`interface.${field}: a PNG`);
    else if (size.width !== size.height || size.width < 48 || size.width > 4096) errors.push(`interface.${field}: square, 48 to 4096 pixels (is ${size.width}x${size.height})`);
    if (statSync(file).size > 5 * 1024 * 1024) errors.push(`interface.${field}: at most 5 MiB`);
  }

  // Skills: each a directory of skills/ with SKILL.md, whose front matter names and describes it.
  const skills = readdirSync(join(root, "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const skill of skills) {
    const text = readFileSync(join(root, "skills", skill, "SKILL.md"), "utf8");
    const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
    const meta = front === undefined ? undefined : parseYaml(front);
    if (!meta?.name || typeof meta.description !== "string" || meta.description.length > 1024 || !body?.trim()) errors.push(`skills/${skill}/SKILL.md: front matter with name and a description of at most 1024 characters, then instructions`);
    else if (`${manifest.name}:${meta.name}`.length > 64) errors.push(`skills/${skill}: ${manifest.name}:${meta.name} is longer than 64 characters`);
    const agent = join(root, "skills", skill, "agents", "openai.yaml");
    if (existsSync(agent)) {
      const { interface: face, ...rest } = parseYaml(readFileSync(agent, "utf8")) ?? {};
      if (!face?.display_name || !face?.short_description) errors.push(`skills/${skill}/agents/openai.yaml: interface.display_name and interface.short_description`);
      if (Object.keys(rest).some(key => key !== "policy" && key !== "dependencies")) errors.push(`skills/${skill}/agents/openai.yaml: only interface, policy and dependencies`);
    }
  }
  if (openai.onboardingSkill && !existsSync(resolve(root, openai.onboardingSkill))) errors.push(`onboardingSkill: ${openai.onboardingSkill} does not exist`);

  // One remote MCP server, over HTTPS.
  const servers = Object.values(mcp.mcpServers ?? {}) as { type?: string; url?: string }[];
  if (servers.length !== 1 || servers[0].type !== "streamable-http" || !https(servers[0].url)) errors.push("mcp.json: exactly one streamable-http server with an https URL");

  // Review cases: five positive, three negative, naming tools the server has.
  const review = openai.review ?? {};
  const names = new Set(tools(() => { throw new Error("not called"); }).map(tool => tool.name));
  const { positive = [], negative = [] } = review.test_cases ?? {};
  if (positive.length !== 5 || negative.length !== 3) errors.push(`review.test_cases: exactly 5 positive and 3 negative (has ${positive.length} and ${negative.length})`);
  for (const [index, test] of positive.entries()) {
    if (!test.description || !test.prompt || !test.tools_triggered || !test.expected_behavior) errors.push(`review.test_cases.positive[${index}]: description, prompt, tools_triggered and expected_behavior`);
    for (const name of String(test.tools_triggered ?? "").split(",").map(name => name.trim()).filter(Boolean)) {
      if (!names.has(name)) errors.push(`review.test_cases.positive[${index}]: no tool named ${name}`);
    }
  }
  for (const [index, test] of negative.entries()) if (!test.description || !test.prompt) errors.push(`review.test_cases.negative[${index}]: description and prompt`);
  if ("test_credentials" in review || "reviewer_instructions" in review) errors.push("review: reviewer credentials and instructions go in the dashboard, never the ZIP");
  if (!review.demo_recording_url) warnings.push("review.demo_recording_url is missing: required to submit an MCP plugin for review");
  else if (!https(review.demo_recording_url)) errors.push("review.demo_recording_url: an https URL");
  if (!openai.publication?.release_notes) warnings.push("publication.release_notes is missing: required to submit for review");

  for (const file of files(root)) {
    if (/\.(json|md|ya?ml|txt)$/.test(file) && SECRET.test(readFileSync(file, "utf8"))) errors.push(`${relative(root, file)}: looks like it holds a token or key`);
  }
  return { errors, warnings, name: manifest.name as string, version: manifest.version as string };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, warnings, name, version } = validate();
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  if (!process.argv.includes("--check")) {
    const dist = join(here, "dist"), zip = join(dist, `${name}-${version}.zip`);
    mkdirSync(dist, { recursive: true });
    rmSync(zip, { force: true });
    // The plugin's files at the archive's root; -X leaves out extra attributes, so the ZIP is the files alone.
    const result = spawnSync("zip", ["-r", "-X", "-q", zip, ".", "-x", "*.DS_Store"], { cwd: PLUGIN_ROOT, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(zip);
  }
}
