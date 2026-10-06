import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * The provider's own tool_choice that makes the model call the tool `name`, as Pi's request builders pass it through
 * (Pi's provider-neutral option has only auto and none). `sole`: it is the only tool the request declares, so "call some
 * tool" forces it as well where a provider cannot name one. Undefined where it cannot be forced: the caller reminds
 * the model instead.
 *
 * Anthropic, on its API or Bedrock's, refuses a forced tool while extended thinking is on, so a model thinking is
 * never forced there. A provider that refuses the parameter for another reason fails the request: the caller then
 * asks again without it.
 */
export function forcedToolChoice(model: Model<Api>, name: string, options: { sole: boolean; thinking: boolean }): unknown {
  switch (model.api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
      return options.thinking && model.reasoning ? undefined : { type: "tool", name };
    case "openai-responses":
    case "azure-openai-responses":
      return { type: "function", name };
    case "openai-completions":
    case "mistral-conversations":
    case "pi-messages":
      return { type: "function", function: { name } };
    case "openai-codex-responses":
      return options.sole ? "required" : undefined;
    case "google-generative-ai":
    case "google-vertex":
      return options.sole ? "any" : undefined;
    default:
      return undefined;
  }
}
