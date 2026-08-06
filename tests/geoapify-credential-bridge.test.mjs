import { afterEach, describe, expect, it } from 'vitest';
import { createGeoapifyCredentialBridge } from '../server/sync/geoapify-credential-bridge.mjs';

describe('Geoapify credential bridge', () => {
  const bridges = [];
  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  });

  it('returns a bounded unavailable response without exposing a credential', async () => {
    const bridge = createGeoapifyCredentialBridge({
      credentialPool: { acquire: async () => null, report: async () => {} },
      pacingAttempts: 1
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 37.574, longitude: 126.977 })
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ code: 'SOURCE_CREDENTIAL_UNAVAILABLE' });
    expect(body).not.toContain('apiKey');
    expect(bridge.unavailable()).toBe(true);
  });

  it('leases each key to one request until its usage has been reported', async () => {
    let used = 0;
    let active = 0;
    let maximumActive = 0;
    const bridge = createGeoapifyCredentialBridge({
      credentialPool: {
        acquire: async (_provider, { excludeIds = [] } = {}) => used || excludeIds.includes('only-key')
          ? null : { id: 'only-key', secret: 'fixture-key' },
        report: async () => { used += 1; }
      },
      fetchImpl: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return Response.json({ results: [] });
      },
      pacingAttempts: 3,
      wait: async () => new Promise((resolve) => setTimeout(resolve, 15))
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const requests = Array.from({ length: 3 }, () => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 37.574, longitude: 126.977 })
    }));
    const responses = await Promise.all(requests);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 503, 503]);
    expect(used).toBe(1);
    expect(maximumActive).toBe(1);
  });
});
