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

  it('queues concurrent requests behind a leased key instead of reporting it unavailable', async () => {
    let used = 0;
    let active = 0;
    let maximumActive = 0;
    const bridge = createGeoapifyCredentialBridge({
      credentialPool: {
        acquire: async (_provider, { excludeIds = [] } = {}) => excludeIds.includes('only-key')
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
    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(used).toBe(3);
    expect(maximumActive).toBe(1);
  });

  it('routes reverse geocoding through the shared credential broker without leasing a key', async () => {
    const calls = [];
    const bridge = createGeoapifyCredentialBridge({
      brokerClient: {
        request: async (operation, parameters) => {
          calls.push([operation, parameters]);
          return { results: [{ postcode: '03000' }] };
        }
      }
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 37.574, longitude: 126.977 })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ postcode: '03000' }] });
    expect(calls).toEqual([['geoapify.reverse', { latitude: 37.574, longitude: 126.977, language: 'ko' }]]);
  });

  it('preserves the broker retry time when all credentials are unavailable', async () => {
    const retryAt = '2026-08-12T00:00:00.000Z';
    const bridge = createGeoapifyCredentialBridge({
      brokerClient: {
        request: async () => { throw Object.assign(new Error('quota'), { code: 'SOURCE_QUOTA_UNAVAILABLE', retryAt }); }
      }
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 37.574, longitude: 126.977 })
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'SOURCE_CREDENTIAL_UNAVAILABLE', nextAvailableAt: retryAt });
    expect(bridge.unavailable()).toBe(true);
    expect(bridge.nextAvailableAt()).toBe(retryAt);
  });

  it('waits through a short broker pacing interval without checkpointing the batch', async () => {
    const waits = [];
    let calls = 0;
    const bridge = createGeoapifyCredentialBridge({
      brokerClient: {
        request: async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('pacing'), {
            code: 'SOURCE_RATE_LIMITED', retryAt: new Date(Date.now() + 200).toISOString()
          });
          return { results: [{ postcode: '03000' }] };
        }
      },
      wait: async (milliseconds) => { waits.push(milliseconds); }
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 37.574, longitude: 126.977 })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ postcode: '03000' }] });
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
    expect(bridge.unavailable()).toBe(false);
    expect(bridge.nextAvailableAt()).toBeNull();
  });
});
