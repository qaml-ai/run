import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelsPage } from '../web/pages/channels';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const channel = { id: 'ch_one', type: 'email', name: 'Support', definition: 'def_one', access: { public: true, allow: [] }, limits: { perSenderPerMinute: 10, turnsPerDay: 1000 }, settings: { address: 'support' }, account: {}, credentials: {}, createdAt: 1790000000000, filter: { instructions: 'A customer needs a reply', threshold: 0.7 } };
const held = { id: 'in_held', conversationId: 'c1', at: 1790000000000, outcome: 'filtered', reason: 'score', score: 0.04, threshold: 0.7, deliverableUntil: 1791000000000, message: { from: { id: 'news@example.com' }, text: 'October deals', files: [] } };
const failed = { id: 'in_failed', conversationId: 'c2', at: 1790000000000, outcome: 'passed', reason: 'decision_failed', threshold: 0.7, error: { status: 502 }, agent: 'agent_two' };

function stub() {
  const writes: { path: string; method: string; body?: any }[] = [];
  let events: any[] = [held, failed];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') writes.push({ path, method, body });
    if (path.endsWith('/deliver')) events = [{ ...held, deliverableUntil: undefined, message: undefined, deliveredAt: 1790000001000 }, failed];
    const result = path.startsWith('/v1/channels/ch_one/events') ? { events } : path === '/v1/channels' ? [channel] : path === '/v1/channels/ch_one' ? channel : path === '/console/discord/config' ? { enabled: false } : [];
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }));
  return writes;
}

it('lists what the filter did and delivers a filtered message', async () => {
  const writes = stub();
  render(<ChannelsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
  await screen.findByText('October deals');
  expect(screen.getByText('0.04 / 0.7')).toBeTruthy();
  expect(screen.getByText('Passed: no answer from the model')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Deliver' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
  await screen.findByText('Delivered by hand');
  expect(writes).toEqual([{ path: '/v1/channels/ch_one/events/in_held/deliver', method: 'POST' }]);
  expect(screen.queryByRole('button', { name: 'Deliver' })).toBeNull();
});

it('edits a channel\'s filter, and removes it', async () => {
  const writes = stub();
  render(<ChannelsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const threshold = await screen.findByLabelText('Threshold');
  fireEvent.change(threshold, { target: { value: '0.8' } });
  fireEvent.change(screen.getByLabelText('Counts as no'), { target: { value: 'spam' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes.length).toBe(1));
  expect(writes[0].body.filter).toEqual({ instructions: 'A customer needs a reply', threshold: 0.8, criteria: { false: 'spam' } });

  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(await screen.findByLabelText('Filter messages before they start a turn'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes.length).toBe(2));
  expect(writes[1].body.filter).toBeNull();
});
