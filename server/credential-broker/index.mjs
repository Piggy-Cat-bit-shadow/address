import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, initializePostgres, PostgresDatabase } from '../database/postgres.mjs';
import { CredentialBrokerStore } from './store.mjs';
import { executeOperation, operationDefinitions } from './operations.mjs';

const REQUEST_LIMIT_BYTES = 16 * 1024;
const releaseId = process.env.ADDRESS_RELEASE?.trim() || 'development';
const tokenDigest = (value) => createHash('sha256').update(value).digest();
const parametersDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const send = (status, body, headers = {}) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Address-Release': releaseId, ...headers }
});

const readBody = async (request) => {
  const chunks = [];
  let bytes = 0;
  if (!request.body) throw Object.assign(new Error('EMPTY_BODY'), { status: 400 });
  for await (const chunk of request.body) {
    bytes += chunk.length;
    if (bytes > REQUEST_LIMIT_BYTES) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('INVALID_JSON'), { status: 400 });
  }
};

class ProviderPriorityGate {
  constructor() { this.providers = new Map(); }

  run(provider, clientId, work) {
    return new Promise((resolvePromise, rejectPromise) => {
      const state = this.providers.get(provider) || { active: false, production: [], test: [] };
      this.providers.set(provider, state);
      state[clientId].push({ work, resolve: resolvePromise, reject: rejectPromise });
      this.#drain(state);
    });
  }

  #drain(state) {
    if (state.active) return;
    const item = state.production.shift() || state.test.shift();
    if (!item) return;
    state.active = true;
    Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
      state.active = false;
      this.#drain(state);
    });
  }
}

const authClient = (request, tokens) => {
  const match = /^Bearer\s+(.+)$/iu.exec(request.headers.get('authorization') || '');
  if (!match) return null;
  const received = tokenDigest(match[1]);
  for (const [clientId, token] of Object.entries(tokens)) {
    const expected = tokenDigest(token);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return clientId;
  }
  return null;
};

const retryHeaders = (nextAvailableAt) => {
  if (!nextAvailableAt) return {};
  const seconds = Math.max(1, Math.ceil((Date.parse(nextAvailableAt) - Date.now()) / 1000));
  return Number.isFinite(seconds) ? { 'Retry-After': String(seconds) } : {};
};

export const createCredentialBroker = async ({
  database,
  masterKey,
  tokens,
  testPolicies = {},
  fetchImpl = fetch,
  now,
  staleMs,
  gate = new ProviderPriorityGate()
}) => {
  if (!database) throw new Error('Credential Broker requires a database');
  if (!tokens?.production || !tokens?.test || tokens.production.length < 24 || tokens.test.length < 24
    || tokens.production === tokens.test) throw new Error('Credential Broker requires distinct production and test tokens');
  const store = new CredentialBrokerStore(database, masterKey, { testPolicies, now, staleMs });
  await store.repairStaleRequests();
  const activeRequests = new Set();

  const execute = async ({ clientId, requestKey, definition, parameters }) => {
    const excluded = [];
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const reservation = await store.reserve({
        requestKey, clientId, provider: definition.provider, excludeIds: excluded
      });
      if (!reservation.credential) {
        const testPolicy = reservation.reason === 'test_policy';
        const status = testPolicy ? 403 : reservation.reason === 'unavailable' ? 503 : 429;
        const code = testPolicy ? 'BROKER_TEST_POLICY_BLOCKED'
          : reservation.reason === 'quota' ? 'SOURCE_QUOTA_UNAVAILABLE'
            : reservation.reason === 'qps' ? 'SOURCE_RATE_LIMITED' : 'SOURCE_CREDENTIAL_UNAVAILABLE';
        const authFailure = reservation.reason === 'auth';
        const responseStatus = authFailure ? 503 : status;
        const responseCode = authFailure ? 'SOURCE_CREDENTIAL_EXPIRED' : code;
        await store.finishRequest(requestKey, { status: 'failed', responseStatus: responseStatus, errorCode: responseCode });
        return send(responseStatus, { code: responseCode, nextAvailableAt: reservation.nextAvailableAt }, retryHeaders(reservation.nextAvailableAt));
      }
      const result = await executeOperation({
        definition, parameters, secret: reservation.credential.secret, fetchImpl
      });
      await store.report({ dispatchId: reservation.dispatchId, outcome: result.outcome || 'success', retryAt: result.retryAt });
      if (result.type === 'success') {
        await store.finishRequest(requestKey, { status: 'completed', responseStatus: result.status });
        return send(result.status, { data: result.data });
      }
      if (result.type === 'error') {
        await store.finishRequest(requestKey, { status: 'failed', responseStatus: result.status, errorCode: result.code });
        return send(result.status, { code: result.code });
      }
      excluded.push(reservation.credential.id);
    }
    await store.finishRequest(requestKey, {
      status: 'failed', responseStatus: 503, errorCode: 'SOURCE_CREDENTIAL_UNAVAILABLE'
    });
    return send(503, { code: 'SOURCE_CREDENTIAL_UNAVAILABLE' });
  };

  const api = async (request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
    if (request.method !== 'POST' || !['/v1/requests', '/v1/availability'].includes(url.pathname)) {
      return send(404, { code: 'NOT_FOUND' });
    }
    const clientId = authClient(request, tokens);
    if (!clientId) return send(401, { code: 'UNAUTHORIZED' });
    let input;
    try { input = await readBody(request); }
    catch (error) { return send(error?.status || 400, { code: error?.message || 'INVALID_REQUEST' }); }
    if (url.pathname === '/v1/availability') {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => key !== 'providers')
        || !Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 8) {
        return send(400, { code: 'INVALID_REQUEST' });
      }
      const providers = [...new Set(input.providers.map(String))];
      if (providers.some((provider) => !['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls'].includes(provider))) {
        return send(400, { code: 'UNSUPPORTED_PROVIDER' });
      }
      const statuses = await Promise.all(providers.map((provider) => store.availability({ clientId, provider })));
      return send(200, { providers: Object.fromEntries(statuses.map((status) => [status.provider, status])) });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['requestId', 'operation', 'parameters'].includes(key))
      || !/^[A-Za-z0-9._:-]{8,128}$/u.test(String(input.requestId || ''))) {
      return send(400, { code: 'INVALID_REQUEST' });
    }
    const definition = operationDefinitions[input.operation];
    if (!definition) return send(400, { code: 'UNSUPPORTED_OPERATION' });
    const parameters = definition.validate(input.parameters);
    if (!parameters) return send(400, { code: 'INVALID_PARAMETERS' });
    const activeKey = `${clientId}:${input.requestId}`;
    if (activeRequests.has(activeKey)) return send(409, { code: 'REQUEST_IN_PROGRESS' });
    activeRequests.add(activeKey);
    let started;
    try {
      started = await store.beginRequest({
        clientId,
        requestId: input.requestId,
        provider: definition.provider,
        operation: input.operation,
        parametersHash: parametersDigest(parameters)
      });
      if (!started.created) {
        const code = started.conflict ? 'REQUEST_ID_CONFLICT'
          : started.request.status === 'pending' ? 'REQUEST_IN_PROGRESS'
            : started.request.status === 'unknown' ? 'BROKER_OUTCOME_UNKNOWN' : 'REQUEST_ALREADY_COMPLETED';
        return send(409, { code });
      }
      return await gate.run(definition.provider, clientId, () => execute({
        clientId, requestKey: started.request.id, definition, parameters
      }));
    } catch {
      if (started?.created) await store.finishRequest(started.request.id, {
        status: 'failed', responseStatus: 500, errorCode: 'BROKER_INTERNAL_ERROR'
      }).catch(() => {});
      return send(500, { code: 'BROKER_INTERNAL_ERROR' });
    } finally {
      activeRequests.delete(activeKey);
    }
  };

  return { api, store };
};

const readSetting = async (environment, name) => {
  if (String(environment[name] || '').trim()) return String(environment[name]).trim();
  const file = String(environment[`${name}_FILE`] || '').trim();
  return file ? String(await readFile(file, 'utf8')).trim() : '';
};

const testPoliciesFrom = (source) => {
  if (!source) return {};
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw new Error('CREDENTIAL_BROKER_TEST_POLICY_JSON is invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((provider) => !['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls'].includes(provider))) {
    throw new Error('CREDENTIAL_BROKER_TEST_POLICY_JSON is invalid');
  }
  return parsed;
};

export const loadCredentialBrokerConfiguration = async (environment = process.env) => ({
  masterKey: await readSetting(environment, 'CONFIG_MASTER_KEY'),
  tokens: {
    production: await readSetting(environment, 'CREDENTIAL_BROKER_PRODUCTION_TOKEN'),
    test: await readSetting(environment, 'CREDENTIAL_BROKER_TEST_TOKEN')
  },
  testPolicies: testPoliciesFrom(environment.CREDENTIAL_BROKER_TEST_POLICY_JSON)
});

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const configuration = await loadCredentialBrokerConfiguration();
  const pool = createPostgresPool({ environment: process.env, application_name: 'address-credential-broker' });
  await initializePostgres(pool);
  const broker = await createCredentialBroker({
    database: new PostgresDatabase(pool),
    ...configuration
  });
  const port = Number.parseInt(process.env.CREDENTIAL_BROKER_PORT || '8792', 10);
  const host = process.env.CREDENTIAL_BROKER_HOST || '127.0.0.1';
  const server = createServer(async (request, response) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > REQUEST_LIMIT_BYTES) {
        response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ code: 'REQUEST_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
      else if (value !== undefined) headers.set(name, value);
    }
    const result = await broker.api(new Request(new URL(request.url || '/', 'http://credential-broker.internal'), {
      method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
    }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  server.listen(port, host, () => console.log(`Credential Broker listening on ${host}:${port}`));
}

export { ProviderPriorityGate };
