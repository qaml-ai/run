import test from 'node:test';
import { assertToolSchema } from './tool-schema-assertions.ts';
import { BUILTINS, builtinDefinitions } from '../src/builtins.ts';
import { delegateTool, agentsTools, REPORT_PROGRESS, SEND_MESSAGE } from '../src/multi-agent.ts';
import { SEND_MESSAGE_TOOL, SEND_MESSAGE_WITH_AGENTS_TOOL } from '../src/core/channels/channels.ts';
import { ASK_AGENT, STAY_SILENT } from '../src/voice/realtime/brain.ts';
import { volumeToolDefinitions } from '../src/volume-tools.ts';
import { GENERATE_IMAGE } from '../src/images.ts';
import { DECIDE } from '../src/decisions.ts';
import { Computers } from '../src/computers/service.ts';

// Every tool the Node backend defines for a model. OpenAI-family APIs refuse a request holding one tool whose parameters
// are not a top-level object. final_output and codemode are checked on a real model request by
// tests/contract/areas/tool-schemas.contract.test.ts.
test('all builtin, file, delegation and computer schemas are top-level objects', async () => {
  const definitions = [...builtinDefinitions(Object.keys(BUILTINS)), ...volumeToolDefinitions(), GENERATE_IMAGE, DECIDE, REPORT_PROGRESS, SEND_MESSAGE, SEND_MESSAGE_TOOL, SEND_MESSAGE_WITH_AGENTS_TOOL, ASK_AGENT, STAY_SILENT];
  for (const settings of [{ instructions: true }, { agents: [{ name: 'researcher', definition: 'researcher' }] }])
    definitions.push(delegateTool(settings, () => undefined), ...agentsTools(settings, () => undefined));
  for (const provider of ['boat', 'browserbase', 'managed']) {
    const computers = new Computers({ enabled: true, db: { query: async (query: string) => ({ rows: query.includes('computer_connections') ? [{ provider, managed: provider === 'managed' }] : [] }) } as never, accounts: {} as never, outbound: {} as never });
    definitions.push(...await computers.tools('fixture', 'fixture'));
  }
  for (const tool of definitions) assertToolSchema(tool.name, tool.parameters);
});
