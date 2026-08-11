import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const readSetting = async (environment, name) => {
  if (String(environment[name] || '').trim()) return String(environment[name]).trim();
  const file = String(environment[`${name}_FILE`] || '').trim();
  return file ? String(await readFile(file, 'utf8')).trim() : '';
};

const parseResponse = async (response) => {
  try { return await response.json(); }
  catch { throw Object.assign(new Error('Credential Broker returned invalid JSON'), { code: 'BROKER_INVALID_RESPONSE' }); }
};

export class CredentialBrokerClient {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = String(url || '').replace(/\/+$/u, '');
    this.token = String(token || '');
    this.fetchImpl = fetchImpl;
    if (!/^https?:\/\//u.test(this.url) || this.token.length < 24) {
      throw new Error('Credential Broker URL and token are required');
    }
  }

  async post(path, body, { signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000)
      });
    } catch (cause) {
      throw Object.assign(new Error('Credential Broker is unavailable', { cause }), { code: 'BROKER_UNAVAILABLE' });
    }
    const payload = await parseResponse(response);
    if (!response.ok) throw Object.assign(new Error(payload.code || 'Credential Broker request failed'), {
      code: payload.code || 'BROKER_REQUEST_FAILED',
      status: response.status,
      retryAt: payload.nextAvailableAt || null
    });
    return payload;
  }

  async request(operation, parameters, { requestId = randomUUID(), signal } = {}) {
    const payload = await this.post('/v1/requests', { requestId, operation, parameters }, { signal });
    return payload.data;
  }

  async availability(providers, { signal } = {}) {
    const payload = await this.post('/v1/availability', { providers }, { signal });
    return payload.providers;
  }
}

export const createCredentialBrokerClient = async (environment = process.env, options = {}) => {
  const url = String(environment.CREDENTIAL_BROKER_URL || '').trim();
  if (!url) return null;
  const token = await readSetting(environment, 'CREDENTIAL_BROKER_TOKEN');
  return new CredentialBrokerClient({ url, token, ...options });
};
