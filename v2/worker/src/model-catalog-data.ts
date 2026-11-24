// First-party provider catalogs are derived directly from `@earendil-works/pi-ai` at module load time.
// Only OpenRouter (compact tuple table avoiding the 307 KiB openrouter.json) and custom/legacy entries
// not present in `@earendil-works/pi-ai` live in static data below.

import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { AZURE_MODELS } from "@earendil-works/pi-ai/providers/azure.models";
import { BASETEN_MODELS } from "@earendil-works/pi-ai/providers/baseten.models";
import { CEREBRAS_MODELS } from "@earendil-works/pi-ai/providers/cerebras.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { NVIDIA_MODELS } from "@earendil-works/pi-ai/providers/nvidia.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { TOGETHER_MODELS } from "@earendil-works/pi-ai/providers/together.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";

export interface ModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelCostSpec {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: ModelCostTier[];
}

export interface V2ModelCatalogEntry {
  id: string;
  provider: string;
  modelId: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  cost: ModelCostSpec;
}

type CompactTier = readonly [above: number, input: number, output: number, cacheRead: number, cacheWrite: number];
type CompactModelRow = readonly [
  provider: string,
  modelId: string,
  reasoning: 0 | 1,
  contextWindow: number,
  maxTokens: number,
  hasImage: 0 | 1,
  inputCost: number,
  outputCost: number,
  cacheRead?: number,
  cacheWrite?: number,
  tiers?: readonly CompactTier[],
];

const PI_AI_PROVIDER_CATALOGS: ReadonlyArray<readonly [provider: string, models: Record<string, Model<Api>>]> = [
  ["openai", OPENAI_MODELS],
  ["anthropic", ANTHROPIC_MODELS],
  ["gemini", GOOGLE_MODELS],
  ["xai", XAI_MODELS],
  ["azure", AZURE_MODELS],
  ["openai-codex", OPENAI_CODEX_MODELS],
  ["deepseek", DEEPSEEK_MODELS],
  ["groq", GROQ_MODELS],
  ["mistral", MISTRAL_MODELS],
  ["together", TOGETHER_MODELS],
  ["fireworks", FIREWORKS_MODELS],
  ["cerebras", CEREBRAS_MODELS],
  ["moonshotai", MOONSHOTAI_MODELS],
  ["minimax", MINIMAX_MODELS],
  ["zai", ZAI_MODELS],
  ["baseten", BASETEN_MODELS],
  ["nvidia", NVIDIA_MODELS],
  ["huggingface", HUGGINGFACE_MODELS],
];

// Custom/legacy non-pi-ai entries + compact OpenRouter table (avoids 307 KiB openrouter.json bundle bloat).
const STATIC_CATALOG_ROWS: readonly CompactModelRow[] = [
  ["azure","deepseek-v4.1-flash",1,1048576,131072,1,0.3,1.2,0.006],
  ["anthropic","claude-3-5-haiku-latest",0,200000,8192,1,0.8,4,0.08,1.0],
  ["anthropic","claude-sonnet-4-0",1,200000,64000,1,3,15,0.3,3.75],
  ["openrouter","meta/muse-ember",0,1048576,32768,1,0.1,0.5,0.004,0.125],
  ["openrouter","google/gemini-4-carbon",1,1048576,65536,1,2,10,0.1,0.1875],
  ["openrouter","deepseek/deepseek-v4.1-flash",1,1048576,131072,1,0.15,0.6,0.003],
  ["openrouter","openai/gpt-6-luna",1,1050000,128000,1,0.1,0.5,0.01,0.125,[[272000,0.2,0.75,0.02,0.25]]],
  ["openrouter","aion-labs/aion-2.0",1,131072,32768,0,0.8,1.6,0.2],
  ["openrouter","aion-labs/aion-3.0",1,131072,32768,0,3,6,0.75],
  ["openrouter","aion-labs/aion-3.0-mini",1,131072,32768,0,0.7,1.4,0.18],
  ["openrouter","aion-labs/aion-3.5",1,262144,32768,0,3,6,0.75],
  ["openrouter","aion-labs/aion-3.5-mini",1,262144,32768,0,0.7,1.4,0.18],
  ["openrouter","amazon/nova-2-lite-v1",1,1000000,65535,1,0.3,2.5],
  ["openrouter","amazon/nova-lite-v1",0,300000,5120,1,0.06,0.24],
  ["openrouter","amazon/nova-micro-v1",0,128000,5120,0,0.035,0.14],
  ["openrouter","amazon/nova-premier-v1",0,1000000,32000,1,2.5,12.5,0.625],
  ["openrouter","amazon/nova-pro-v1",0,300000,5120,1,0.8,3.2],
  ["openrouter","anthropic/claude-fable-5",1,1000000,128000,1,10,50,1,12.5],
  ["openrouter","anthropic/claude-fable-5.1",1,1000000,128000,1,10,50,0.25,12.5],
  ["openrouter","anthropic/claude-fable-5.1:batch",1,1000000,128000,1,5,25,0.125,6.25],
  ["openrouter","anthropic/claude-fable-5:batch",1,1000000,128000,1,5,25,0.5,6.25],
  ["openrouter","anthropic/claude-haiku-4.5",1,200000,64000,1,1,5,0.1,1.25],
  ["openrouter","anthropic/claude-haiku-4.5:batch",1,200000,64000,1,0.5,2.5,0.05,0.625],
  ["openrouter","anthropic/claude-haiku-5.5",1,1000000,128000,1,0.1,0.5,0.01,0.125,[[100000,0.5,2.5,0.05,0.625]]],
  ["openrouter","anthropic/claude-haiku-5.5:batch",1,1000000,128000,1,0.05,0.25,0.005,0.0625,[[100000,0.25,1.25,0.025,0.3125]]],
  ["openrouter","anthropic/claude-opus-4.1",1,200000,32000,1,15,75,1.5,18.75],
  ["openrouter","anthropic/claude-opus-4.1:batch",1,200000,32000,1,7.5,37.5,0.75,9.375],
  ["openrouter","anthropic/claude-opus-4.5",1,200000,64000,1,5,25,0.5,6.25],
  ["openrouter","anthropic/claude-opus-4.5:batch",1,200000,64000,1,2.5,12.5,0.25,3.125],
  ["openrouter","anthropic/claude-opus-4.6",1,1000000,128000,1,5,25,0.5,6.25],
  ["openrouter","anthropic/claude-opus-4.6:batch",1,1000000,128000,1,2.5,12.5,0.25,3.125],
  ["openrouter","anthropic/claude-opus-4.7",1,1000000,128000,1,5,25,0.5,6.25],
  ["openrouter","anthropic/claude-opus-4.7:batch",1,1000000,128000,1,2.5,12.5,0.25,3.125],
  ["openrouter","anthropic/claude-opus-4.8",1,1000000,128000,1,5,25,0.5,6.25],
  ["openrouter","anthropic/claude-opus-4.8:batch",1,1000000,128000,1,2.5,12.5,0.25,3.125],
  ["openrouter","anthropic/claude-opus-5",1,1000000,128000,1,5,25,0.5,6.25],
  ["openrouter","anthropic/claude-opus-5.5",1,1000000,128000,1,4,20,0.2,5],
  ["openrouter","anthropic/claude-opus-5.5:batch",1,1000000,128000,1,2,10,0.1,2.5],
  ["openrouter","anthropic/claude-opus-5:batch",1,1000000,128000,1,2.5,12.5,0.25,3.125],
  ["openrouter","anthropic/claude-sonnet-4.5",1,1000000,64000,1,3,15,0.3,3.75,[[200000,6,22.5,0.6,7.5]]],
  ["openrouter","anthropic/claude-sonnet-4.5:batch",1,1000000,64000,1,1.5,7.5,0.15,1.875,[[200000,3,11.25,0.3,3.75]]],
  ["openrouter","anthropic/claude-sonnet-4.6",1,1000000,128000,1,3,15,0.3,3.75],
  ["openrouter","anthropic/claude-sonnet-4.6:batch",1,1000000,128000,1,1.5,7.5,0.15,1.875],
  ["openrouter","anthropic/claude-sonnet-5",1,1000000,128000,1,2,10,0.2,2.5],
  ["openrouter","anthropic/claude-sonnet-5.5",1,1000000,128000,1,2,10,0.1,2.5],
  ["openrouter","anthropic/claude-sonnet-5.5:batch",1,1000000,128000,1,1,5,0.05,1.25],
  ["openrouter","anthropic/claude-sonnet-5:batch",1,1000000,128000,1,1,5,0.1,1.25],
  ["openrouter","auto",1,2000000,30000,1,0,0],
  ["openrouter","bytedance-seed/seed-1.6",1,262144,32768,1,0.25,2,0,0,[[128000,0.5,4,0,0]]],
  ["openrouter","bytedance-seed/seed-1.6-flash",1,262144,32768,1,0.075,0.3,0,0,[[128000,0.1,0.8,0,0]]],
  ["openrouter","bytedance-seed/seed-2-1-turbo",1,262144,235929,1,0.5,2.5],
  ["openrouter","bytedance-seed/seed-2.0-code",1,262144,131072,1,0.5,3,0,0,[[128000,1,6,0,0]]],
  ["openrouter","bytedance-seed/seed-2.0-lite",1,262144,131072,1,0.25,2,0,0,[[128000,0.5,4,0,0]]],
  ["openrouter","bytedance-seed/seed-2.0-mini",1,262144,131072,1,0.1,0.4,0,0,[[128000,0.2,0.8,0,0]]],
  ["openrouter","cohere/command-a-plus",1,192000,64000,1,0.3,1.5,0.15],
  ["openrouter","cohere/command-r-08-2024",0,128000,4000,0,0.15,0.6],
  ["openrouter","cohere/command-r-plus-08-2024",0,128000,4000,0,2.5,10],
  ["openrouter","cohere/north-mini-code:free",1,256000,64000,0,0,0],
  ["openrouter","deepseek/deepseek-chat",0,128000,16000,0,0.2574,1.0287],
  ["openrouter","deepseek/deepseek-chat-v3-0324",0,128000,115200,0,0.29,1.14,0.11],
  ["openrouter","deepseek/deepseek-chat-v3.1",1,163840,147456,0,0.25,0.95,0.13],
  ["openrouter","deepseek/deepseek-r1-0528",1,163840,32768,0,0.5,2.15,0.35],
  ["openrouter","deepseek/deepseek-v3.1-terminus",1,163840,147456,0,0.27,1],
  ["openrouter","deepseek/deepseek-v3.2",1,163840,147456,0,0.26,0.38,0.13],
  ["openrouter","deepseek/deepseek-v3.2-exp",1,163840,147456,0,0.27,0.41],
  ["openrouter","deepseek/deepseek-v4-flash",1,1048575,943717,0,0.091,0.182,0.0182],
  ["openrouter","deepseek/deepseek-v4-flash-0731",1,1048576,943718,0,0.119,0.238,0.0238],
  ["openrouter","deepseek/deepseek-v4-flash-vision-exp",1,1048576,262144,1,0.2156,0.6468,0.00686],
  ["openrouter","deepseek/deepseek-v4-pro",1,1048576,393216,0,1.6,3.2,0.135],
  ["openrouter","deepseek/deepseek-v4-pro-0813",1,1048576,943718,0,0.115,4,0.11],
  ["openrouter","deepseek/deepseek-v4.1-flash-1017",1,1048576,131072,1,0.15,0.6,0.003],
  ["openrouter","deepseek/deepseek-v4.1-flash:batch",1,1048576,384000,1,0.05,0.15,0.004],
  ["openrouter","dots-studio/dots-3-note-preview:free",1,512000,460800,1,0,0],
  ["openrouter","elorian/glimpse",1,262144,256000,1,0.6,3,0.06],
  ["openrouter","fireworks/ember-1",1,1048576,943718,1,3,15,0.3],
  ["openrouter","google/gemini-2.5-flash",1,1048576,65535,1,0.3,2.5,0.03,0.083333],
  ["openrouter","google/gemini-2.5-flash-lite",1,1048576,65535,1,0.1,0.4,0.01,0.083333],
  ["openrouter","google/gemini-2.5-pro",1,1048576,65536,1,1.25,10,0.125,0.375,[[200000,2.5,15,0.25,0.375]]],
  ["openrouter","google/gemini-2.5-pro-preview",1,1048576,65536,1,1.25,10,0.125,0.375,[[200000,2.5,15,0.25,0.375]]],
  ["openrouter","google/gemini-3-flash-preview",1,1048576,65536,1,0.5,3,0.05,0.083333],
  ["openrouter","google/gemini-3-flash-preview:batch",1,1048576,65536,1,0.25,1.5],
  ["openrouter","google/gemini-3-pro-image",1,65536,32768,1,2,12,0.2,0.375],
  ["openrouter","google/gemini-3.1-flash-lite",1,1048576,65536,1,0.25,1.5,0.025,0.083333],
  ["openrouter","google/gemini-3.1-flash-lite-preview",1,1048576,65536,1,0.25,1.5,0.025,0.083333],
  ["openrouter","google/gemini-3.1-flash-lite:batch",1,1048576,65536,1,0.125,0.75,0.0125],
  ["openrouter","google/gemini-3.1-pro-preview",1,1048576,65536,1,2,12,0.2,0.375,[[200000,4,18,0.4,0.375]]],
  ["openrouter","google/gemini-3.1-pro-preview-customtools",1,1048576,65536,1,2,12,0.2,0.375,[[200000,4,18,0.4,0.375]]],
  ["openrouter","google/gemini-3.1-pro-preview:batch",1,1048576,65536,1,1,6,0,0,[[200000,2,9,0,0]]],
  ["openrouter","google/gemini-3.5-flash",1,1048576,65536,1,1.5,9,0.15,0.083333],
  ["openrouter","google/gemini-3.5-flash-lite",1,1048576,65536,1,0.3,2.5,0.03,0.083333],
  ["openrouter","google/gemini-3.5-flash-lite:batch",1,1048576,65536,1,0.15,1.25,0.015],
  ["openrouter","google/gemini-3.5-flash:batch",1,1048576,65536,1,0.75,4.5,0.075],
  ["openrouter","google/gemini-3.6-flash",1,1048576,65536,1,0.75,3.75,0.075,0.041667],
  ["openrouter","google/gemini-3.6-flash:batch",1,1048576,65536,1,0.375,1.875,0.0375,0.041667],
  ["openrouter","google/gemini-3.7-flash",1,1048576,65536,1,0.75,3.75,0.075,0.041667],
  ["openrouter","google/gemini-3.7-flash:batch",1,1048576,65536,1,0.375,1.875,0.0375,0.041667],
  ["openrouter","google/gemini-3.8-flash",1,1048576,65536,1,0.825,4.125,0.0825,0.041667],
  ["openrouter","google/gemini-3.8-flash:batch",1,1048576,65536,1,0.375,1.875,0.0375,0.041667],
  ["openrouter","google/gemini-4-argon",1,1048576,943718,1,2,10,0.1,0.1875],
  ["openrouter","google/gemini-4-argon:batch",1,1048576,943718,1,1,5,0.05,0.1875],
  ["openrouter","google/gemini-nano-banana-2.1",1,65536,58982,1,1.5,7.5],
  ["openrouter","google/gemma-3-12b-it",0,131072,16384,1,0.05,0.15],
  ["openrouter","google/gemma-3-27b-it",0,131072,117964,1,0.08,0.35,0.04],
  ["openrouter","google/gemma-4-26b-a4b-it",1,262144,32768,1,0.093,0.278,0.046],
  ["openrouter","google/gemma-4-26b-a4b-it:free",1,262144,32768,1,0,0],
  ["openrouter","google/gemma-4-31b-it",1,262144,16384,1,0.2,0.4],
  ["openrouter","google/gemma-4-31b-it:free",1,262144,32768,1,0,0],
  ["openrouter","ibm-granite/granite-4.2-8b",1,131072,117964,0,0.06,0.15,0.015],
  ["openrouter","inception/mercury-2",1,128000,50000,0,0.25,0.75,0.025],
  ["openrouter","inception/mercury-2.5",1,260000,65536,0,0.04,0.15,0.004],
  ["openrouter","inception/mercury-3",1,1000000,131072,0,0.1,0.35,0.01],
  ["openrouter","inclusionai/ling-3.0-flash",1,262144,32768,0,0.021,0.063,0.0042],
  ["openrouter","inclusionai/ling-3.0-flash-vl",1,131072,32768,1,0.06,0.18,0.012],
  ["openrouter","inclusionai/ling-3.1-flash",1,1000000,262144,0,0.075,0.225,0.015],
  ["openrouter","liquid/lfm-2.5-2.6b",1,128000,8192,0,0.35,0.5,0.04],
  ["openrouter","liquid/lfm-2.5-2.6b:free",1,65536,8192,0,0,0],
  ["openrouter","liquid/lfm-2.5-24b-a2b",1,128000,8192,0,0.05,0.7,0.025],
  ["openrouter","meituan/longcat-2.0",1,1048756,262144,0,0.3,1.2,0.006],
  ["openrouter","meta-llama/llama-3.1-70b-instruct",0,131072,16384,0,0.4,0.4],
  ["openrouter","meta-llama/llama-3.1-8b-instruct",0,131072,117964,0,0.05,0.08,0.025],
  ["openrouter","meta-llama/llama-3.3-70b-instruct",0,131072,16384,0,0.1,0.32],
  ["openrouter","meta-llama/llama-4-maverick",0,128000,16384,1,0.1875,0.6525,0.05],
  ["openrouter","meta-llama/llama-4-scout",0,327680,16384,1,0.1,0.3],
  ["openrouter","meta/muse-glimmer-30b",1,131072,16384,1,0.3,1.2,0.04],
  ["openrouter","meta/muse-spark-1.1",1,1048576,943718,1,1.25,4.25,0.15],
  ["openrouter","meta/muse-spark-1.2",1,1048576,943718,1,1.25,4.25,0.15],
  ["openrouter","meta/muse-spark-1.2-contributor",1,1048576,943718,1,0.1,0.2,0.002],
  ["openrouter","meta/muse-spark-1.3",1,1048576,943718,1,1.25,4.25,0.15],
  ["openrouter","meta/muse-spark-1.3-contributor",1,1048576,943718,1,0.1,0.2,0.002],
  ["openrouter","meta/muse-spark-open",1,1048576,943718,1,1.25,4.25,0.15],
  ["openrouter","meta/muse-wonder",1,1048576,943718,1,4,20,0.2],
  ["openrouter","minimax/minimax-m1",1,1000000,40000,0,0.55,2.2],
  ["openrouter","minimax/minimax-m2",1,204800,131072,0,0.255,1.02],
  ["openrouter","minimax/minimax-m2.1",1,204800,131072,0,0.3,1.2,0.03],
  ["openrouter","minimax/minimax-m2.5",1,198000,32768,0,0.27,0.95,0.03],
  ["openrouter","minimax/minimax-m2.7",1,204800,131072,0,0.3,1.2,0.06],
  ["openrouter","minimax/minimax-m3",1,524288,512000,1,0.3,1.2,0.06],
  ["openrouter","minimax/minimax-m3.1-flash",1,1048576,524288,1,0.075,0.3,0.0075],
  ["openrouter","mistralai/codestral-2508",0,256000,204800,0,0.3,0.9,0.03],
  ["openrouter","mistralai/devstral-2512",0,262144,209715,0,0.4,2,0.04],
  ["openrouter","mistralai/ministral-14b-2512",0,262144,209715,1,0.2,0.2,0.02],
  ["openrouter","mistralai/ministral-3b-2512",0,131072,104857,1,0.1,0.1,0.01],
  ["openrouter","mistralai/ministral-8b-2512",0,262144,209715,1,0.15,0.15,0.015],
  ["openrouter","mistralai/mistral-large",0,128000,102400,0,2,6,0.2],
  ["openrouter","mistralai/mistral-large-2407",0,131072,104857,0,2,6,0.2],
  ["openrouter","mistralai/mistral-large-2512",0,262144,209715,1,0.5,1.5,0.05],
  ["openrouter","mistralai/mistral-large-4-0",1,1048576,262144,1,0.7,2.1,0.07],
  ["openrouter","mistralai/mistral-medium-3",0,131072,104857,1,0.4,2,0.04],
  ["openrouter","mistralai/mistral-medium-3-5",1,262144,209715,1,1.5,7.5],
  ["openrouter","mistralai/mistral-medium-3-5:batch",1,262144,209715,1,0.75,3.75],
  ["openrouter","mistralai/mistral-medium-3.1",0,131072,104857,1,0.4,2,0.04],
  ["openrouter","mistralai/mistral-nemo",0,131072,16384,0,0.029,0.03],
  ["openrouter","mistralai/mistral-saba",0,32768,26214,0,0.2,0.6,0.02],
  ["openrouter","mistralai/mistral-small-2603",1,262144,209715,1,0.15,0.6,0.015],
  ["openrouter","mistralai/mistral-small-3.1-24b-instruct",0,128000,102400,1,0.351,0.555],
  ["openrouter","mistralai/mistral-small-3.2-24b-instruct",0,128000,16384,1,0.075,0.2],
  ["openrouter","mistralai/mixtral-8x22b-instruct",0,65536,52428,0,2,6,0.2],
  ["openrouter","mistralai/voxtral-small-24b-2507",0,32768,26214,0,0.1,0.3,0.01],
  ["openrouter","moonshotai/kimi-k2",0,131072,98304,0,0.57,2.3],
  ["openrouter","moonshotai/kimi-k2-0905",0,262144,98304,0,0.6,2.5],
  ["openrouter","moonshotai/kimi-k2-thinking",1,262144,98304,0,0.6,2.5,0.15],
  ["openrouter","moonshotai/kimi-k2.5",1,262144,4096,1,0.41,2.06,0.07],
  ["openrouter","moonshotai/kimi-k2.6",1,262144,235929,1,0.65,3.41,0.15],
  ["openrouter","moonshotai/kimi-k2.7-code",1,262144,235929,1,0.6,3.5,0.15],
  ["openrouter","moonshotai/kimi-k3",1,1048576,131072,1,0.304,11.936,0.21],
  ["openrouter","moonshotai/kimi-k3.1-pro",1,1048576,131072,1,2,10,0.2],
  ["openrouter","moonshotai/kimi-k3:batch",1,1048576,16384,1,2.28,11.4,0.228],
  ["openrouter","nex-agi/nex-n2.5-pro",1,262144,235929,1,0.075,0.25,0.015],
  ["openrouter","nvidia/nemotron-3-nano-30b-a3b",1,262144,235929,0,0.06,0.24,0.012],
  ["openrouter","nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",1,256000,65536,1,0,0],
  ["openrouter","nvidia/nemotron-3-super-120b-a12b",1,1048576,262144,0,0.3,2.4,0.15],
  ["openrouter","nvidia/nemotron-3-ultra-550b-a55b",1,202800,182520,0,0.6,2.4,0.12],
  ["openrouter","nvidia/nemotron-3-ultra-550b-a55b:free",1,1000000,65536,0,0,0],
  ["openrouter","nvidia/nemotron-3.5-lightning",1,262144,235929,0,0.07,0.2,0.04],
  ["openrouter","nvidia/nemotron-3.5-lightning:free",1,1000000,65536,0,0,0],
  ["openrouter","nvidia/nemotron-3.5-super-vl",1,262144,235929,1,0.15,0.5,0.02],
  ["openrouter","nvidia/nemotron-3.5-super-vl:free",1,1000000,131072,1,0,0],
  ["openrouter","openai/gpt-3.5-turbo-0613",0,4095,3685,0,1,2],
  ["openrouter","openai/gpt-3.5-turbo-16k",0,16385,4096,0,3,4],
  ["openrouter","openai/gpt-4",0,8191,4096,0,30,60],
  ["openrouter","openai/gpt-4-turbo:batch",0,128000,4096,1,5,15],
  ["openrouter","openai/gpt-4.1",0,1047576,32768,1,2,8,0.5],
  ["openrouter","openai/gpt-4.1-mini",0,1047576,32768,1,0.4,1.6,0.1],
  ["openrouter","openai/gpt-4.1-mini:batch",0,1047576,32768,1,0.2,0.8,0.05],
  ["openrouter","openai/gpt-4.1-nano",0,1047576,942818,1,0.1,0.4,0.03],
  ["openrouter","openai/gpt-4.1-nano:batch",0,1047576,32768,1,0.05,0.2,0.0125],
  ["openrouter","openai/gpt-4.1:batch",0,1047576,32768,1,1,4,0.25],
  ["openrouter","openai/gpt-4o",0,128000,16384,1,2.5,10,1.25],
  ["openrouter","openai/gpt-4o-2024-05-13",0,128000,4096,1,5,15],
  ["openrouter","openai/gpt-4o-2024-08-06",0,128000,16384,1,2.5,10,1.25],
  ["openrouter","openai/gpt-4o-2024-11-20",0,128000,16384,1,2.5,10,1.25],
  ["openrouter","openai/gpt-4o-mini",0,128000,16384,1,0.15,0.6,0.075],
  ["openrouter","openai/gpt-4o-mini-2024-07-18",0,128000,16384,1,0.15,0.6,0.075],
  ["openrouter","openai/gpt-4o-mini:batch",0,128000,16384,1,0.075,0.3,0.0375],
  ["openrouter","openai/gpt-4o:batch",0,128000,16384,1,1.25,5,0.625],
  ["openrouter","openai/gpt-5",1,400000,128000,1,1.25,10,0.125],
  ["openrouter","openai/gpt-5-mini",1,400000,128000,1,0.25,2,0.025],
  ["openrouter","openai/gpt-5-mini:batch",1,400000,128000,1,0.125,1,0.0125],
  ["openrouter","openai/gpt-5-nano",1,400000,128000,1,0.05,0.4,0.005],
  ["openrouter","openai/gpt-5-nano:batch",1,400000,128000,1,0.025,0.2,0.0025],
  ["openrouter","openai/gpt-5-pro",1,400000,128000,1,15,120],
  ["openrouter","openai/gpt-5-pro:batch",1,400000,128000,1,7.5,60],
  ["openrouter","openai/gpt-5.1",1,400000,128000,1,1.25,10,0.125],
  ["openrouter","openai/gpt-5.1-codex",1,400000,128000,1,1.25,10,0.13],
  ["openrouter","openai/gpt-5.1-codex-max",1,400000,128000,1,1.25,10,0.125],
  ["openrouter","openai/gpt-5.1-codex-mini",1,400000,128000,1,0.25,2,0.03],
  ["openrouter","openai/gpt-5.1:batch",1,400000,128000,1,0.625,5,0.0625],
  ["openrouter","openai/gpt-5.2",1,400000,128000,1,1.75,14,0.175],
  ["openrouter","openai/gpt-5.2-chat",0,128000,32000,1,1.75,14,0.175],
  ["openrouter","openai/gpt-5.2-codex",1,400000,128000,1,1.75,14,0.175],
  ["openrouter","openai/gpt-5.2-pro",1,400000,128000,1,21,168],
  ["openrouter","openai/gpt-5.2-pro:batch",1,400000,128000,1,10.5,84],
  ["openrouter","openai/gpt-5.2:batch",1,400000,128000,1,0.875,7,0.0875],
  ["openrouter","openai/gpt-5.3-codex",1,400000,128000,1,1.75,14,0.175],
  ["openrouter","openai/gpt-5.4",1,1050000,128000,1,2.5,15,0.25,0,[[272000,5,22.5,0.5,0]]],
  ["openrouter","openai/gpt-5.4-mini",1,400000,128000,1,0.75,4.5,0.075],
  ["openrouter","openai/gpt-5.4-mini:batch",1,400000,128000,1,0.375,2.25,0.0375],
  ["openrouter","openai/gpt-5.4-nano",1,400000,128000,1,0.2,1.25,0.02],
  ["openrouter","openai/gpt-5.4-nano:batch",1,400000,128000,1,0.1,0.625,0.01],
  ["openrouter","openai/gpt-5.4-pro",1,1050000,128000,1,30,180,0,0,[[272000,60,270,0,0]]],
  ["openrouter","openai/gpt-5.4-pro:batch",1,1050000,128000,1,15,90,0,0,[[272000,30,135,0,0]]],
  ["openrouter","openai/gpt-5.4:batch",1,1050000,128000,1,1.25,7.5,0.125,0,[[272000,2.5,11.25,0.25,0]]],
  ["openrouter","openai/gpt-5.5",1,1050000,128000,1,5,30,0.5,0,[[272000,10,45,1,0]]],
  ["openrouter","openai/gpt-5.5-pro",1,1050000,128000,1,30,180,0,0,[[272000,60,270,0,0]]],
  ["openrouter","openai/gpt-5.5-pro:batch",1,1050000,128000,1,15,90,0,0,[[272000,30,135,0,0]]],
  ["openrouter","openai/gpt-5.5:batch",1,1050000,128000,1,2.5,15,0.25,0,[[272000,5,22.5,0.5,0]]],
  ["openrouter","openai/gpt-5.6-luna",1,1050000,128000,1,0.2,1.2,0.02,0.25,[[272000,0.4,1.8,0.04,0.5]]],
  ["openrouter","openai/gpt-5.6-luna-pro",1,1050000,128000,1,0.2,1.2,0.02,0.25,[[272000,0.4,1.8,0.04,0.5]]],
  ["openrouter","openai/gpt-5.6-luna-pro:batch",1,1050000,128000,1,0.1,0.6,0.01,0,[[272000,0.2,0.9,0.02,0]]],
  ["openrouter","openai/gpt-5.6-luna:batch",1,1050000,128000,1,0.1,0.6,0.01,0,[[272000,0.2,0.9,0.02,0]]],
  ["openrouter","openai/gpt-5.6-sol",1,1050000,128000,1,4,20,0.4,5,[[272000,8,30,0.8,10]]],
  ["openrouter","openai/gpt-5.6-sol-pro",1,1050000,128000,1,4,20,0.4,5,[[272000,8,30,0.8,10]]],
  ["openrouter","openai/gpt-5.6-sol-pro:batch",1,1050000,128000,1,2,10,0.2,2.5,[[272000,4,15,0.4,5]]],
  ["openrouter","openai/gpt-5.6-sol:batch",1,1050000,128000,1,2,10,0.2,2.5,[[272000,4,15,0.4,5]]],
  ["openrouter","openai/gpt-5.6-terra",1,1050000,128000,1,2,12,0.2,2.5,[[272000,4,18,0.4,5]]],
  ["openrouter","openai/gpt-5.6-terra-pro",1,1050000,128000,1,2,12,0.2,2.5,[[272000,4,18,0.4,5]]],
  ["openrouter","openai/gpt-5.6-terra-pro:batch",1,1050000,128000,1,1,6,0.1,0,[[272000,2,9,0.2,0]]],
  ["openrouter","openai/gpt-5.6-terra:batch",1,1050000,128000,1,1,6,0.1,0,[[272000,2,9,0.2,0]]],
  ["openrouter","openai/gpt-5:batch",1,400000,128000,1,0.625,5,0.0625],
  ["openrouter","openai/gpt-6-astra",1,1050000,128000,1,10,50,1,12.5,[[272000,20,75,2,25]]],
  ["openrouter","openai/gpt-6-astra-pro",1,1050000,128000,1,10,50,1,12.5,[[272000,20,75,2,25]]],
  ["openrouter","openai/gpt-6-astra-pro:batch",1,1050000,128000,1,5,25,0.5,6.25,[[272000,10,37.5,1,12.5]]],
  ["openrouter","openai/gpt-6-astra:batch",1,1050000,128000,1,5,25,0.5,6.25,[[272000,10,37.5,1,12.5]]],
  ["openrouter","openai/gpt-6-luna-pro",1,1050000,128000,1,0.1,0.5,0.01,0.125,[[272000,0.2,0.75,0.02,0.25]]],
  ["openrouter","openai/gpt-6-luna-pro:batch",1,1050000,128000,1,0.05,0.25,0.005,0.0625,[[272000,0.1,0.375,0.01,0.125]]],
  ["openrouter","openai/gpt-6-luna:batch",1,1050000,128000,1,0.05,0.25,0.005,0.0625,[[272000,0.1,0.375,0.01,0.125]]],
  ["openrouter","openai/gpt-6-sol",1,1050000,128000,1,2,10,0.2,2.5,[[272000,4,15,0.4,5]]],
  ["openrouter","openai/gpt-6-sol-pro",1,1050000,128000,1,2,10,0.2,2.5,[[272000,4,15,0.4,5]]],
  ["openrouter","openai/gpt-6-sol-pro:batch",1,1050000,128000,1,1,5,0.1,1.25,[[272000,2,7.5,0.2,2.5]]],
  ["openrouter","openai/gpt-6-sol:batch",1,1050000,128000,1,1,5,0.1,1.25,[[272000,2,7.5,0.2,2.5]]],
  ["openrouter","openai/gpt-6.1-sol",1,1050000,128000,1,2,10,0.1,2.5,[[272000,4,15,0.2,5]]],
  ["openrouter","openai/gpt-6.1-sol-pro",1,1050000,128000,1,2,10,0.1,2.5,[[272000,4,15,0.2,5]]],
  ["openrouter","openai/gpt-6.1-sol-pro:batch",1,1050000,128000,1,1,5,0.05,1.25,[[272000,2,7.5,0.1,2.5]]],
  ["openrouter","openai/gpt-6.1-sol:batch",1,1050000,128000,1,1,5,0.05,1.25,[[272000,2,7.5,0.1,2.5]]],
  ["openrouter","openai/gpt-6.1-terra",1,1050000,128000,1,1,5,0.05,1.25,[[272000,2,7.5,0.1,2.5]]],
  ["openrouter","openai/gpt-6.1-terra-pro",1,1050000,128000,1,1,5,0.05,1.25,[[272000,2,7.5,0.1,2.5]]],
  ["openrouter","openai/gpt-6.1-terra-pro:batch",1,1050000,128000,1,0.5,2.5,0.025,0.625,[[272000,1,3.75,0.05,1.25]]],
  ["openrouter","openai/gpt-6.1-terra:batch",1,1050000,128000,1,0.5,2.5,0.025,0.625,[[272000,1,3.75,0.05,1.25]]],
  ["openrouter","openai/gpt-audio",0,128000,16384,0,2.5,10],
  ["openrouter","openai/gpt-audio-mini",0,128000,16384,0,0.6,2.4],
  ["openrouter","openai/gpt-chat-latest",0,400000,128000,1,5,30,0.5],
  ["openrouter","openai/gpt-oss-120b",1,131072,65536,0,0.15,0.6,0.075],
  ["openrouter","openai/gpt-oss-120b:batch",1,131072,117964,0,0.0296,0.136],
  ["openrouter","openai/gpt-oss-20b",1,131072,117964,0,0.03,0.13,0.03],
  ["openrouter","openai/gpt-oss-20b:batch",1,131072,117964,0,0.024,0.112],
  ["openrouter","openai/gpt-oss-safeguard-20b",1,131072,65536,0,0.075,0.3,0.0375],
  ["openrouter","openai/o3",1,200000,100000,1,2,8,0.5],
  ["openrouter","openai/o3-mini:batch",1,200000,100000,0,0.55,2.2,0.275],
  ["openrouter","openai/o3-pro",1,200000,100000,1,20,80],
  ["openrouter","openai/o3:batch",1,200000,100000,1,1,4,0.25],
  ["openrouter","openai/o4-mini:batch",1,200000,100000,1,0.55,2.2,0.1375],
  ["openrouter","openrouter/auto",1,2000000,4096,1,0,0],
  ["openrouter","openrouter/auto-beta",1,2000000,65536,1,0,0],
  ["openrouter","openrouter/free",1,200000,4096,1,0,0],
  ["openrouter","openrouter/fusion",1,1000000,30000,0,0,0],
  ["openrouter","openrouter/pareto-code",1,2000000,4096,0,0,0],
  ["openrouter","particle-ai/particle-1",1,1048576,131072,1,0.05,0.5,0.003],
  ["openrouter","perceptron/perceptron-mk1.5",1,36864,8192,1,0.15,1.5],
  ["openrouter","prism-ml/ternary-bonsai-2-27b",1,262144,32768,1,0.075,0.5,0.0375],
  ["openrouter","prism-ml/ternary-bonsai-2-9b",1,262144,65536,1,0.08,0.13,0.04],
  ["openrouter","qwen/qwen-2.5-72b-instruct",0,32768,16384,0,0.36,0.4],
  ["openrouter","qwen/qwen-2.5-7b-instruct",0,32768,29491,0,0.1,0.2],
  ["openrouter","qwen/qwen-plus",0,1000000,32768,0,0.26,0.78,0.052,0.325,[[256000,0.78,2.34,0.156,0.975]]],
  ["openrouter","qwen/qwen3-14b",1,40960,16384,0,0.12,0.24],
  ["openrouter","qwen/qwen3-235b-a22b-2507",0,262144,16384,0,0.09,0.55],
  ["openrouter","qwen/qwen3-235b-a22b-thinking-2507",1,128000,16384,0,0.45,3.5],
  ["openrouter","qwen/qwen3-30b-a3b",1,40960,16384,0,0.12,0.5],
  ["openrouter","qwen/qwen3-30b-a3b-instruct-2507",0,262144,235929,0,0.1,0.3,0.1],
  ["openrouter","qwen/qwen3-32b",1,40960,16384,0,0.08,0.28],
  ["openrouter","qwen/qwen3-coder",0,262144,65536,0,0.3,1,0.1],
  ["openrouter","qwen/qwen3-coder-30b-a3b-instruct",0,262144,235929,0,0.07,0.28],
  ["openrouter","qwen/qwen3-coder-flash",0,1000000,65536,0,0.195,0.975,0.039,0.24375,[[32000,0.325,1.625,0.065,0.40625],[128000,0.52,2.6,0.104,0.65]]],
  ["openrouter","qwen/qwen3-coder-next",0,262144,235929,0,0.12,0.8,0.07],
  ["openrouter","qwen/qwen3-next-80b-a3b-instruct",0,262144,16384,0,0.09,1.1],
  ["openrouter","qwen/qwen3-vl-235b-a22b-instruct",0,131072,32768,1,0.21,1.9,0.1],
  ["openrouter","qwen/qwen3-vl-30b-a3b-instruct",0,262144,16384,1,0.15,0.6],
  ["openrouter","qwen/qwen3-vl-30b-a3b-thinking",1,262144,235929,1,0.29,1],
  ["openrouter","qwen/qwen3-vl-8b-instruct",0,262144,235929,1,0.25,0.75,0.12],
  ["openrouter","qwen/qwen3.5-122b-a10b",1,262144,65536,1,0.26,2.08],
  ["openrouter","qwen/qwen3.5-27b",1,262144,81920,1,0.26,2.6],
  ["openrouter","qwen/qwen3.5-35b-a3b",1,262144,81920,1,0.14,1,0.05],
  ["openrouter","qwen/qwen3.5-397b-a17b",1,262144,235929,1,0.5,3.6,0.3],
  ["openrouter","qwen/qwen3.5-9b",1,262144,235929,1,0.17,0.25],
  ["openrouter","qwen/qwen3.5-flash-02-23",1,1000000,65536,1,0.065,0.26],
  ["openrouter","qwen/qwen3.5-plus-02-15",1,1000000,65536,1,0.26,1.56,0,0,[[256000,0.325,1.95,0,0]]],
  ["openrouter","qwen/qwen3.5-plus-20260420",1,1000000,65536,1,0.3,1.8,0,0.375,[[256000,0.375,2.25,0,0.46875]]],
  ["openrouter","qwen/qwen3.6-27b",1,262144,65536,1,0.45,2.7],
  ["openrouter","qwen/qwen3.6-35b-a3b",1,262144,235929,1,0.1,0.9,0.025],
  ["openrouter","qwen/qwen3.6-flash",1,1000000,65536,1,0.1875,1.125,0,0.234375,[[256000,0.75,3,0,0.9375]]],
  ["openrouter","qwen/qwen3.6-plus",1,1000000,65536,1,0.325,1.95,0,0.40625,[[256000,1.3,3.9,0,1.625]]],
  ["openrouter","qwen/qwen3.7-flash",1,1000000,65536,1,0.03,0.13,0.006,0.038,[[32000,0.1,0.4,0.02,0.125],[256000,0.2,0.8,0.04,0.25]]],
  ["openrouter","qwen/qwen3.7-max",1,1000000,131072,0,1.475,4.425,0.295,1.84375],
  ["openrouter","qwen/qwen3.7-plus",1,1000000,131072,1,0.32,1.28,0.064,0.4,[[256000,0.96,3.84,0.192,1.2]]],
  ["openrouter","qwen/qwen3.7-plus:batch",1,262144,131072,1,0.23,0.92],
  ["openrouter","qwen/qwen3.8-2.4t-a95b",1,1000000,131072,0,2,6,0.25],
  ["openrouter","qwen/qwen3.8-27b",1,262144,235929,1,0.15,1.875,0.0375],
  ["openrouter","qwen/qwen3.8-flash",1,1000000,131072,1,0.15,0.47,0.016],
  ["openrouter","qwen/qwen3.8-max-0902",1,1000000,131072,1,2,6,0.25],
  ["openrouter","qwen/qwen3.8-max-prime",1,1000000,131072,1,4,12,0.5],
  ["openrouter","qwen/qwen3.8-omni-flash",1,1000000,131072,1,0.15,0.47,0.016],
  ["openrouter","recursive/flint-v1.0:free",1,262144,235929,0,0,0],
  ["openrouter","reflection/beam-1.0-501b-a23b",1,1048576,131072,0,0.25,1,0.05],
  ["openrouter","rekaai/reka-edge",0,16384,14745,1,0.1,0.1],
  ["openrouter","relace/relace-search",0,256000,128000,0,1,3],
  ["openrouter","sakana/fugu-max",1,1000000,128000,1,2,6,0.25],
  ["openrouter","sakana/fugu-ultra",1,1000000,128000,1,5,30,0.5,0,[[272000,10,45,1,0]]],
  ["openrouter","sakana/fugu-ultra-v2",1,1000000,128000,1,5,30,0.5,0,[[272000,10,45,1,0]]],
  ["openrouter","sakana/sakana-namazu",1,262144,65536,1,0.95,4,0.15],
  ["openrouter","stepfun/step-3.5-flash",1,262144,65536,0,0.1,0.3],
  ["openrouter","stepfun/step-3.7-flash",1,256000,230400,1,0.2,1.15,0.04],
  ["openrouter","stepfun/step-5-preview",1,1000000,64000,1,1,2.7,0.1],
  ["openrouter","tencent/hy3",1,262144,128000,0,0.0825,0.33,0.020625],
  ["openrouter","tencent/hy3-preview",1,262144,235929,0,0.18,0.6,0.06],
  ["openrouter","tencent/hy4-preview",1,1048576,64000,0,0.7506,2.2509,0.0378],
  ["openrouter","thinkingmachines/inkling",1,524288,471859,1,1,4.05,0.17],
  ["openrouter","thinkingmachines/inkling-small",1,524288,262144,1,0.45,1.2,0.1],
  ["openrouter","thinkingmachines/inkling-small:free",1,1048576,262144,1,0,0],
  ["openrouter","thinkingmachines/inkling:free",1,1048576,262144,1,0,0],
  ["openrouter","typesafe/jev-router",1,1000000,65536,1,0,0],
  ["openrouter","unbiased/pareto-26.10",0,1048576,131072,1,0.8,3.2,0.03],
  ["openrouter","unbiased/pareto-26.9",0,262144,131072,1,2.5,7.5,0.25],
  ["openrouter","upstage/solar-mini4",1,524288,131072,0,0.05,0.2,0.005],
  ["openrouter","upstage/solar-pro4",1,524288,131072,0,0.15,0.6,0.03],
  ["openrouter","x-ai/grok-4.20",1,2000000,1800000,1,1.25,2.5,0.2,0,[[200000,2.5,5,0.4,0]]],
  ["openrouter","x-ai/grok-4.3",1,1000000,900000,1,1.25,2.5,0.2,0,[[200000,2.5,5,0.4,0]]],
  ["openrouter","x-ai/grok-4.3:batch",1,1000000,900000,1,1,2,0.16,0,[[200000,2,4,0.32,0]]],
  ["openrouter","x-ai/grok-4.5",1,500000,450000,1,2,6,0.3,0,[[200000,4,12,0.6,0]]],
  ["openrouter","x-ai/grok-4.6",1,500000,450000,1,2,6,0.5,0,[[200000,4,12,1,0]]],
  ["openrouter","x-ai/grok-4.7",1,500000,450000,1,2,6,0.5,0,[[200000,4,12,1,0]]],
  ["openrouter","x-ai/grok-build-0.1",1,256000,230400,1,1,2,0.2,0,[[200000,2,4,0.4,0]]],
  ["openrouter","xiaomi/mimo-v2.5",1,1000000,65536,1,0.4,2,0.08],
  ["openrouter","xiaomi/mimo-v2.5-pro",1,262144,235929,0,0.48,1.8,0.096],
  ["openrouter","xiaomi/mimo-v2.6-flash",1,1048576,131072,1,0.14,0.28,0.0028],
  ["openrouter","xiaomi/mimo-v2.6-pro",1,1048576,131072,1,0.435,0.87,0.0036],
  ["openrouter","xiaomi/mimo-v2.6-pro-ultraspeed",1,1048576,131072,1,4.35,8.7,0.036],
  ["openrouter","xingchen-agi/xing4.0-29b-a4b:free",1,262144,235929,0,0,0],
  ["openrouter","z-ai/glm-4.5",1,131072,98304,0,0.6,2.2,0.11],
  ["openrouter","z-ai/glm-4.5-air",1,131072,98304,0,0.13,0.85,0.025],
  ["openrouter","z-ai/glm-4.5v",1,65536,16384,1,0.6,1.8,0.11],
  ["openrouter","z-ai/glm-4.6",1,202752,131072,0,0.5,2,0.1],
  ["openrouter","z-ai/glm-4.6v",1,131072,32768,1,0.3,0.9,0.055],
  ["openrouter","z-ai/glm-4.7",1,202752,131072,0,0.6,2.2,0.11],
  ["openrouter","z-ai/glm-4.7-flash",1,131072,117964,0,0.0605,0.4],
  ["openrouter","z-ai/glm-5",1,202752,131072,0,0.6,1.9,0.119],
  ["openrouter","z-ai/glm-5-turbo",1,202752,131072,0,1.2,4,0.24],
  ["openrouter","z-ai/glm-5.1",1,202752,131072,0,1.4,4.4,0.26],
  ["openrouter","z-ai/glm-5.2",1,1048576,943718,0,0.006,6.8,0.005],
  ["openrouter","z-ai/glm-5.3",1,1048576,943718,0,0.079,4.8,0.078],
  ["openrouter","z-ai/glm-5.3-flash",1,1048576,131072,1,0.0285,0.0923,0.0285],
  ["openrouter","z-ai/glm-5.3-flash:batch",1,1048576,131072,1,0.05,0.18,0.01],
  ["openrouter","z-ai/glm-5.3-flashx",1,1048576,131072,1,0.37,1.25,0.075],
  ["openrouter","z-ai/glm-5.3-flashx-legal",1,1048576,131072,1,0.37,1.25,0.075],
  ["openrouter","z-ai/glm-5.3-prime",1,1000000,131072,0,2.8,8.8,0.56],
  ["openrouter","z-ai/glm-5.3:batch",1,1048576,131072,0,0.45,2,0.1],
  ["openrouter","z-ai/glm-5v-turbo",1,202752,131072,1,1.2,4,0.24],
];

function fromPiAiModels(
  provider: string,
  models: Record<string, Model<Api>>,
): V2ModelCatalogEntry[] {
  const out: V2ModelCatalogEntry[] = [];
  for (const m of Object.values(models)) {
    const cost: ModelCostSpec = {
      input: m.cost.input,
      output: m.cost.output,
    };
    if (m.cost.cacheRead > 0) cost.cacheRead = m.cost.cacheRead;
    if (m.cost.cacheWrite > 0) cost.cacheWrite = m.cost.cacheWrite;
    if (m.cost.tiers && m.cost.tiers.length > 0) {
      cost.tiers = m.cost.tiers.map((t) => ({
        inputTokensAbove: t.inputTokensAbove,
        input: t.input,
        output: t.output,
        ...(t.cacheRead > 0 ? { cacheRead: t.cacheRead } : {}),
        ...(t.cacheWrite > 0 ? { cacheWrite: t.cacheWrite } : {}),
      }));
    }
    out.push({
      id: `${provider}/${m.id}`,
      provider,
      modelId: m.id,
      reasoning: Boolean(m.reasoning),
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: m.input.includes("image") ? ["text", "image"] : ["text"],
      cost,
    });
  }
  return out;
}

function expandRow(row: CompactModelRow): V2ModelCatalogEntry {
  const [provider, modelId, reasoning, contextWindow, maxTokens, hasImage, input, output, cacheRead, cacheWrite, rawTiers] = row;
  const cost: ModelCostSpec = { input, output };
  if (cacheRead !== undefined && cacheRead > 0) cost.cacheRead = cacheRead;
  if (cacheWrite !== undefined && cacheWrite > 0) cost.cacheWrite = cacheWrite;
  if (rawTiers && rawTiers.length > 0) {
    cost.tiers = rawTiers.map(([inputTokensAbove, tIn, tOut, tCr, tCw]) => ({
      inputTokensAbove,
      input: tIn,
      output: tOut,
      ...(tCr > 0 ? { cacheRead: tCr } : {}),
      ...(tCw > 0 ? { cacheWrite: tCw } : {}),
    }));
  }
  return {
    id: `${provider}/${modelId}`,
    provider,
    modelId,
    reasoning: reasoning === 1,
    contextWindow,
    maxTokens,
    input: hasImage === 1 ? ["text", "image"] : ["text"],
    cost,
  };
}

function buildCatalog(): V2ModelCatalogEntry[] {
  const entries: V2ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: V2ModelCatalogEntry) => {
    const key = entry.id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  for (const [provider, models] of PI_AI_PROVIDER_CATALOGS) {
    for (const entry of fromPiAiModels(provider, models)) {
      add(entry);
    }
  }
  for (const row of STATIC_CATALOG_ROWS) {
    add(expandRow(row));
  }
  return entries;
}

export const V2_MODEL_CATALOG: V2ModelCatalogEntry[] = buildCatalog();

const CATALOG_BY_ID = new Map<string, V2ModelCatalogEntry>();
const CATALOG_BY_MODEL_ID = new Map<string, V2ModelCatalogEntry>();

for (const entry of V2_MODEL_CATALOG) {
  CATALOG_BY_ID.set(entry.id.toLowerCase(), entry);
  if (entry.provider === "gemini") {
    CATALOG_BY_ID.set(`google/${entry.modelId}`.toLowerCase(), entry);
  }
  // Prefer direct first-party provider entries for bare modelId lookups over aggregator entries.
  const bareKey = entry.modelId.toLowerCase();
  const existing = CATALOG_BY_MODEL_ID.get(bareKey);
  if (!existing || (existing.provider === "openrouter" && entry.provider !== "openrouter")) {
    CATALOG_BY_MODEL_ID.set(bareKey, entry);
  }
}

export function lookupCatalogModel(rawModel: string): V2ModelCatalogEntry | undefined {
  const lower = rawModel.trim().toLowerCase();
  if (!lower) return undefined;
  const exact = CATALOG_BY_ID.get(lower);
  if (exact) return exact;
  if (lower.startsWith("openai-responses/")) {
    const asOpenAi = CATALOG_BY_ID.get(`openai/${lower.slice("openai-responses/".length)}`);
    if (asOpenAi) return asOpenAi;
  }
  const slash = lower.indexOf("/");
  const bare = slash > 0 ? lower.slice(slash + 1) : lower;
  return CATALOG_BY_MODEL_ID.get(bare);
}
