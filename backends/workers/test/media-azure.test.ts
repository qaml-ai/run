import assert from 'node:assert/strict';
import test from 'node:test';
import { azureCredentials, mediaAzure } from '../src/media-azure.ts';

test('Azure standalone media reuses source defaults, deployment switches and credentials', () => {
  assert.equal(mediaAzure({}), undefined);
  const azure = mediaAzure({ AGENT_AZURE_OPENAI_ENDPOINT: 'https://fixture.openai.azure.com/', AGENT_AZURE_OPENAI_API_KEY: 'synthetic-azure-key' })!;
  assert.equal(azure.endpoint, 'https://fixture.openai.azure.com');
  assert.equal(azure.imageDeployment, 'gpt-image-2.5-flare');
  assert.equal(azure.transcriptionDeployment, 'gpt-transcribe');
  assert.equal(azure.realtimeDeployment, undefined);
  const disabled = mediaAzure({ AGENT_AZURE_OPENAI_ENDPOINT: azure.endpoint, AGENT_AZURE_OPENAI_API_KEY: 'synthetic-azure-key', AGENT_AZURE_IMAGE_DEPLOYMENT: '', AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT: '' })!;
  assert.equal(disabled.imageDeployment, undefined);
  assert.equal(disabled.transcriptionDeployment, undefined);
  const credentials = azureCredentials(azure, 'image-fixture', { apiKey: 'synthetic-fallback-key' });
  assert.equal(credentials.baseUrl, 'https://fixture.openai.azure.com/openai/deployments/image-fixture');
  assert.equal(credentials.query, 'api-version=2025-04-01-preview');
  assert.equal(credentials.apiKey, '');
  assert.ok(credentials.secrets['api-key'] === 'synthetic-azure-key');
  assert.ok(credentials.fallback.apiKey === 'synthetic-fallback-key');
});

test('Azure endpoint and deployment validation only permits configured loopback in TEST_MODE', () => {
  assert.throws(() => mediaAzure({ AGENT_AZURE_OPENAI_API_KEY: 'synthetic' }), /must give endpoint/);
  const local = { AGENT_AZURE_OPENAI_ENDPOINT: 'http://127.0.0.1:12345', AGENT_AZURE_OPENAI_API_KEY: 'synthetic' };
  assert.throws(() => mediaAzure(local), /outside TEST_MODE/);
  assert.equal(mediaAzure({ ...local, TEST_MODE: '1' })?.endpoint, local.AGENT_AZURE_OPENAI_ENDPOINT);
  assert.throws(() => mediaAzure({ ...local, AGENT_AZURE_OPENAI_ENDPOINT: 'https://localhost' }), /outside TEST_MODE/);
  assert.throws(() => mediaAzure({ ...local, TEST_MODE: '1', AGENT_AZURE_OPENAI_ENDPOINT: 'http://example.com' }), /must be https/);
  assert.throws(() => mediaAzure({ ...local, TEST_MODE: '1', AGENT_AZURE_IMAGE_DEPLOYMENT: '../wrong' }), /deployment name/);
});
