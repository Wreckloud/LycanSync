import { afterEach, describe, expect, test, vi } from 'vitest';
import { nextPresenceWaitRequest, waitForGroupPresenceChanges } from './groupApi';

describe('group presence change waiting API', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('sends only the group cursor and client waiter identity to the fixed endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      serverInstanceId: '5c2a4eef-5d3b-46c6-a442-06345a8756fd', version: 4, changed: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const waiter = nextPresenceWaitRequest();
    const controller = new AbortController();

    const response = await waitForGroupPresenceChanges('group-id', waiter.clientId, waiter.requestId,
      { serverInstanceId: '94eb5687-3dc2-4fc0-a2b0-c6b575f0d0b2', version: 3 }, controller.signal);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/api/groups/group-id/presence-changes');
    expect(parsed.searchParams.get('clientId')).toBe(waiter.clientId);
    expect(parsed.searchParams.get('requestId')).toBe(String(waiter.requestId));
    expect(parsed.searchParams.get('serverInstanceId')).toBe('94eb5687-3dc2-4fc0-a2b0-c6b575f0d0b2');
    expect(parsed.searchParams.get('version')).toBe('3');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    expect(response).toEqual({ serverInstanceId: '5c2a4eef-5d3b-46c6-a442-06345a8756fd', version: 4, changed: true });
  });
});
