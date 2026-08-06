import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryAtFrom = (response) => {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1000).toISOString();
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
};

const readBody = async (request) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 4096) throw Object.assign(new Error('Bridge request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const send = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  response.end(payload);
};

export const createGeoapifyCredentialBridge = ({
  credentialPool,
  fetchImpl = fetch,
  signal,
  wait = delay,
  pacingAttempts = 20
}) => {
  if (!credentialPool) throw new Error('A Geoapify credential pool is required');
  const token = randomUUID();
  let acquireTail = Promise.resolve();
  let unavailable = false;
  const inFlight = new Set();

  const acquire = async (options) => {
    let release;
    const previous = acquireTail;
    acquireTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const credential = await credentialPool.acquire('geoapify', {
        ...options,
        excludeIds: [...new Set([...(options.excludeIds || []), ...inFlight])]
      });
      if (credential) inFlight.add(credential.id);
      return credential;
    } finally {
      release();
    }
  };

  const reverseGeocode = async ({ latitude, longitude }) => {
    const attempted = new Set();
    for (let pacingAttempt = 0; pacingAttempt < pacingAttempts; pacingAttempt += 1) {
      const credential = await acquire({ excludeIds: attempted });
      if (!credential) {
        if (pacingAttempt + 1 < pacingAttempts) await wait(100);
        continue;
      }
      attempted.add(credential.id);
      try {
        const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
        url.searchParams.set('lat', String(latitude));
        url.searchParams.set('lon', String(longitude));
        url.searchParams.set('format', 'json');
        url.searchParams.set('lang', 'ko');
        url.searchParams.set('apiKey', credential.secret);
        let response;
        try {
          response = await fetchImpl(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'address-sync/2.0' },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
          });
        } catch (error) {
          if (signal?.aborted) throw Object.assign(error, { code: 'SYNC_PROCESS_ABORTED' });
          await credentialPool.report(credential.id, 'network');
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          await credentialPool.report(credential.id, 'auth');
          continue;
        }
        if (response.status === 429) {
          const retryAt = retryAtFrom(response);
          const quota = retryAt && Date.parse(retryAt) - Date.now() > 5 * 60_000;
          await credentialPool.report(credential.id, quota ? 'quota' : 'qps', { retryAt });
          continue;
        }
        if (response.status >= 500) {
          await credentialPool.report(credential.id, 'network', { retryAt: retryAtFrom(response) });
          continue;
        }
        if (!response.ok) {
          await credentialPool.report(credential.id, 'success');
          throw Object.assign(new Error(`Geoapify returned HTTP ${response.status}`), { status: response.status });
        }
        let body;
        try {
          body = await response.json();
        } catch {
          await credentialPool.report(credential.id, 'network');
          continue;
        }
        await credentialPool.report(credential.id, 'success');
        unavailable = false;
        return body;
      } finally {
        inFlight.delete(credential.id);
      }
    }
    unavailable = true;
    throw Object.assign(new Error('No Geoapify credential is currently available'), {
      code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
    });
  };

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== `/${token}`) {
      send(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    try {
      const body = await readBody(request);
      const latitude = Number(body?.latitude);
      const longitude = Number(body?.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
          || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        send(response, 400, { code: 'INVALID_COORDINATES' });
        return;
      }
      send(response, 200, await reverseGeocode({ latitude, longitude }));
    } catch (error) {
      send(response, error?.code === 'SOURCE_CREDENTIAL_UNAVAILABLE' ? 503 : Number(error?.status || 502), {
        code: error?.code || 'GEOAPIFY_BRIDGE_FAILED'
      });
    }
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}/${token}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    unavailable: () => unavailable
  };
};
