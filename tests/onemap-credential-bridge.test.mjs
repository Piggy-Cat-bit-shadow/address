import { afterEach, describe, expect, it } from 'vitest';
import { createOneMapCredentialBridge } from '../server/sync/onemap-credential-bridge.mjs';

describe('OneMap credential bridge', () => {
  const bridges = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  });

  it('routes a fixed search operation through the broker without exposing credentials', async () => {
    const calls = [];
    const bridge = createOneMapCredentialBridge({
      brokerClient: {
        request: async (operation, parameters) => {
          calls.push([operation, parameters]);
          return { results: [{ POSTAL: '339944' }] };
        }
      }
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '26 BENDEMEER RD' })
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ results: [{ POSTAL: '339944' }] });
    expect(calls).toEqual([['onemap.search', { searchVal: '26 BENDEMEER RD' }]]);
    expect(body).not.toContain('Authorization');
    expect(body).not.toContain('Bearer');
  });

  it.each([
    ['SOURCE_QUOTA_UNAVAILABLE', 429, '2026-08-11T00:00:00.000Z'],
    ['SOURCE_CREDENTIAL_UNAVAILABLE', 503, null],
    ['BROKER_UNAVAILABLE', 502, null]
  ])('preserves bounded broker failure %s', async (code, status, retryAt) => {
    const bridge = createOneMapCredentialBridge({
      brokerClient: {
        request: async () => { throw Object.assign(new Error(code), { code, retryAt }); }
      }
    });
    bridges.push(bridge);
    const response = await fetch(await bridge.start(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '26 BENDEMEER RD' })
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, nextAvailableAt: retryAt });
  });
});
