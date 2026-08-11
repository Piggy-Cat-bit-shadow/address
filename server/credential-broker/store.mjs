import { createDecipheriv, createHash } from 'node:crypto';

const periodStart = (period, offsetMinutes, date) => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000).toISOString();
  return period === 'month' ? shifted.slice(0, 7) : shifted.slice(0, 10);
};

const nextReset = (period, offsetMinutes, date) => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  if (period === 'month') shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  else shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
};

const masterKeyFrom = (value) => {
  if (Buffer.isBuffer(value)) return value;
  const source = String(value || '').trim();
  const key = /^[a-f\d]{64}$/iu.test(source) ? Buffer.from(source, 'hex') : Buffer.from(source, 'base64');
  if (key.length !== 32) throw new Error('CONFIG_MASTER_KEY must decode to exactly 32 bytes');
  return key;
};

const decrypt = (row, key) => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.secret_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.secret_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.secret_ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
};

const boundedPolicy = (value) => {
  const cap = Number(value?.cap);
  const reserve = Number(value?.reserve);
  return Number.isSafeInteger(cap) && cap >= 0 && Number.isSafeInteger(reserve) && reserve >= 0
    ? { cap, reserve } : null;
};

const observationCurrent = (row, now) => row?.observed_at
  && (!row.reset_at || Date.parse(row.reset_at) > now.getTime());

export class CredentialBrokerStore {
  constructor(database, masterKey, {
    now = () => new Date(),
    testPolicies = {},
    staleMs = 2 * 60_000
  } = {}) {
    this.database = database;
    this.masterKey = masterKeyFrom(masterKey);
    this.now = now;
    this.testPolicies = Object.fromEntries(Object.entries(testPolicies)
      .map(([provider, policy]) => [provider, boundedPolicy(policy)]).filter(([, policy]) => policy));
    this.staleMs = staleMs;
  }

  async beginRequest({ clientId, requestId, provider, operation, parametersHash }) {
    const now = this.now().toISOString();
    const prior = await this.database.prepare(`SELECT * FROM credential_broker_requests
      WHERE client_id=? AND request_id=?`).bind(clientId, requestId).first();
    if (prior) {
      const same = prior.provider === provider && prior.operation === operation
        && prior.parameters_hash === parametersHash;
      return { created: false, conflict: !same, request: prior };
    }
    const insertion = await this.database.prepare(`INSERT INTO credential_broker_requests(
        client_id,request_id,provider,operation,parameters_hash,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,'pending',?,?) ON CONFLICT(client_id,request_id) DO NOTHING`)
      .bind(clientId, requestId, provider, operation, parametersHash, now, now).run();
    const existing = await this.database.prepare(`SELECT * FROM credential_broker_requests
      WHERE client_id=? AND request_id=?`).bind(clientId, requestId).first();
    if (!existing) throw new Error('BROKER_REQUEST_LOOKUP_FAILED');
    if (Number(insertion.meta?.changes || 0) === 1) return { created: true, request: existing };
    const same = existing.provider === provider && existing.operation === operation
      && existing.parameters_hash === parametersHash;
    return { created: false, conflict: !same, request: existing };
  }

  async availability({ clientId, provider }) {
    const now = this.now();
    if (clientId === 'test' && !this.testPolicies[provider]) {
      return {
        provider, known: true, available: false, nextResetAt: null, waitState: 'blocked',
        reason: `broker_test_policy_missing:${provider}`, revision: 'test-policy-missing'
      };
    }
    const rows = (await this.database.prepare(`SELECT id,status,cooldown_until,provider_reported_reset_at,
        enabled,weight,qps_limit,quota_service,quota_period,quota_limit,quota_timezone_offset,quota_scope_id,last_used_at
      FROM provider_credentials WHERE provider=? ORDER BY id`).bind(provider).all()).results;
    const candidates = rows.filter((row) => Boolean(row.enabled) && String(row.status || '') !== 'disabled');
    if (!candidates.length) return {
      provider, known: rows.length > 0, available: false, nextResetAt: null, waitState: 'blocked',
      reason: rows.length ? `api_key_disabled:${provider}` : `missing_api_key:${provider}`,
      revision: createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    };
    let available = false;
    let nextAvailable = 0;
    let waitState = 'blocked';
    const revision = [];
    for (const row of candidates) {
      revision.push([row.id, row.enabled, row.weight, row.qps_limit, row.quota_service, row.quota_period,
        row.quota_limit, row.quota_timezone_offset, row.quota_scope_id]);
      if (String(row.status || '') === 'needs_review') continue;
      let blockedUntil = Math.max(
        Date.parse(row.cooldown_until || '') || 0,
        row.last_used_at ? Date.parse(row.last_used_at) + 1000 / Number(row.qps_limit || 1) : 0
      );
      let blockedByQuota = false;
      const windows = (await this.database.prepare(`SELECT service,scope_id,period,limit_count,timezone_offset
        FROM provider_quota_windows WHERE credential_id=? AND enabled=1 ORDER BY scope_id,service,period`)
        .bind(row.id).all()).results;
      const effectiveWindows = windows.length ? windows : [{
        service: row.quota_service, scope_id: row.quota_scope_id, period: row.quota_period,
        limit_count: row.quota_limit, timezone_offset: row.quota_timezone_offset
      }];
      for (const window of effectiveWindows) {
        revision.push([row.id, window.service, window.scope_id, window.period,
          window.limit_count, window.timezone_offset]);
        const start = periodStart(window.period, Number(window.timezone_offset || 0), now);
        const localUsed = Number(await this.database.prepare(`SELECT COALESCE(SUM(
            usage.accepted_count+usage.rejected_count),0) AS total
          FROM provider_credentials credential JOIN provider_usage_periods usage
            ON usage.credential_id=credential.id
          WHERE credential.quota_scope_id=? AND credential.quota_service=? AND usage.period_start=?`)
          .bind(window.scope_id, window.service, start).first('total') || 0);
        const counter = await this.database.prepare(`SELECT dispatch_count,test_count,limit_count
          FROM credential_broker_quota_counters
          WHERE scope_id=? AND service=? AND period=? AND period_start=?`)
          .bind(window.scope_id, window.service, window.period, start).first();
        const observation = await this.database.prepare(`SELECT MAX(observation.used_count) AS used_count,
            MIN(observation.limit_count) AS limit_count,MAX(observation.reset_at) AS reset_at,
            MAX(observation.observed_at) AS observed_at
          FROM provider_quota_observations observation JOIN provider_credentials credential
            ON credential.id=observation.credential_id
          WHERE credential.quota_scope_id=? AND observation.service=? AND observation.period=?`)
          .bind(window.scope_id, window.service, window.period).first();
        const observed = observationCurrent(observation, now) ? Number(observation.used_count || 0) : 0;
        const observedLimit = observationCurrent(observation, now) && Number(observation.limit_count) > 0
          ? Number(observation.limit_count) : Number.MAX_SAFE_INTEGER;
        const limit = Math.min(Number(window.limit_count), Number(counter?.limit_count || window.limit_count), observedLimit);
        const used = Math.max(localUsed, Number(counter?.dispatch_count || 0), observed);
        const policy = this.testPolicies[provider];
        const testBlocked = clientId === 'test'
          && (Number(counter?.test_count || 0) >= policy.cap || used >= Math.max(0, limit - policy.reserve));
        if (used >= limit || testBlocked) {
          blockedByQuota = true;
          const reset = observationCurrent(observation, now) && observation.reset_at
            ? Date.parse(observation.reset_at)
            : nextReset(window.period, Number(window.timezone_offset || 0), now).getTime();
          blockedUntil = Math.max(blockedUntil, reset);
        }
      }
      if (blockedUntil <= now.getTime() && !blockedByQuota) {
        available = true;
        continue;
      }
      if (blockedUntil && (!nextAvailable || blockedUntil < nextAvailable)) {
        nextAvailable = blockedUntil;
        waitState = blockedByQuota ? 'quota_wait' : 'cooldown_wait';
      }
    }
    return {
      provider, known: true, available,
      nextResetAt: available || !nextAvailable ? null : new Date(nextAvailable).toISOString(),
      waitState: available ? null : waitState,
      reason: available || waitState !== 'blocked' ? null : `api_key_needs_review:${provider}`,
      revision: createHash('sha256').update(JSON.stringify(revision.sort())).digest('hex')
    };
  }

  async reserve({ requestKey, clientId, provider, excludeIds = [] }) {
    return await this.database.transaction(async (database) => {
      const now = this.now();
      const nowIso = now.toISOString();
      await database.prepare(`UPDATE provider_credentials SET status='healthy',cooldown_until=NULL,
        provider_reported_used=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_used END,
        provider_reported_limit=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_limit END,
        provider_reported_reset_at=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_reset_at END,
        provider_reported_at=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_at END,updated_at=?
        WHERE status IN ('cooldown','quota_exhausted') AND cooldown_until IS NOT NULL AND cooldown_until<=?`)
        .bind(nowIso, nowIso).run();
      const rows = (await database.prepare(`SELECT * FROM provider_credentials
        WHERE provider=? AND enabled=1 AND status NOT IN ('disabled','needs_review')
        ORDER BY last_used_at IS NOT NULL,last_used_at,created_at,id FOR UPDATE`)
        .bind(provider).all()).results;
      const excluded = new Set(excludeIds);
      let nextAvailableAt = null;
      let blockedReason = 'unavailable';
      for (const row of rows) {
        const cooldownAt = Date.parse(row.cooldown_until || '');
        if (cooldownAt > now.getTime()) {
          const candidate = new Date(cooldownAt).toISOString();
          if (!nextAvailableAt || candidate < nextAvailableAt) nextAvailableAt = candidate;
          blockedReason = row.status === 'quota_exhausted' ? 'quota' : 'qps';
          continue;
        }
        if (excluded.has(row.id)) continue;
        const pacingAt = row.last_used_at
          ? Date.parse(row.last_used_at) + 1000 / Number(row.qps_limit || 1) : 0;
        if (pacingAt > now.getTime()) {
          const candidate = new Date(pacingAt).toISOString();
          if (!nextAvailableAt || candidate < nextAvailableAt) nextAvailableAt = candidate;
          blockedReason = 'qps';
          continue;
        }
        let secret;
        try {
          secret = decrypt(row, this.masterKey);
        } catch {
          await database.prepare("UPDATE provider_credentials SET status='needs_review',updated_at=? WHERE id=?")
            .bind(nowIso, row.id).run();
          continue;
        }
        const windows = (await database.prepare(`SELECT service,scope_id,period,limit_count,timezone_offset
          FROM provider_quota_windows WHERE credential_id=? AND enabled=1
          ORDER BY scope_id,service,period`).bind(row.id).all()).results;
        const effectiveWindows = windows.length ? windows : [{
          service: row.quota_service,
          scope_id: row.quota_scope_id,
          period: row.quota_period,
          limit_count: row.quota_limit,
          timezone_offset: row.quota_timezone_offset
        }];
        const counters = [];
        let blocked = false;
        let candidateBlockedUntil = 0;
        let candidateBlockedReason = 'quota';
        for (const window of effectiveWindows) {
          const start = periodStart(window.period, Number(window.timezone_offset || 0), now);
          const localUsed = Number(await database.prepare(`SELECT COALESCE(SUM(
              usage.accepted_count+usage.rejected_count),0) AS total
            FROM provider_credentials credential JOIN provider_usage_periods usage
              ON usage.credential_id=credential.id
            WHERE credential.quota_scope_id=? AND credential.quota_service=? AND usage.period_start=?`)
            .bind(window.scope_id, window.service, start).first('total') || 0);
          await database.prepare(`INSERT INTO credential_broker_quota_counters(
              scope_id,service,period,period_start,limit_count,dispatch_count,production_count,test_count,updated_at
            ) VALUES (?,?,?,?,?,?,?,0,?) ON CONFLICT(scope_id,service,period,period_start) DO NOTHING`)
            .bind(window.scope_id, window.service, window.period, start, window.limit_count,
              localUsed, localUsed, nowIso).run();
          const counter = await database.prepare(`SELECT * FROM credential_broker_quota_counters
            WHERE scope_id=? AND service=? AND period=? AND period_start=? FOR UPDATE`)
            .bind(window.scope_id, window.service, window.period, start).first();
          const observation = await database.prepare(`SELECT MAX(observation.used_count) AS used_count,
              MIN(observation.limit_count) AS limit_count,MAX(observation.reset_at) AS reset_at,
              MAX(observation.observed_at) AS observed_at
            FROM provider_quota_observations observation JOIN provider_credentials credential
              ON credential.id=observation.credential_id
            WHERE credential.quota_scope_id=? AND observation.service=? AND observation.period=?`)
            .bind(window.scope_id, window.service, window.period).first();
          const observed = observationCurrent(observation, now) ? Number(observation.used_count || 0) : 0;
          const observedLimit = observationCurrent(observation, now) && Number(observation.limit_count) > 0
            ? Number(observation.limit_count) : Number.MAX_SAFE_INTEGER;
          const limit = Math.min(Number(counter.limit_count), Number(window.limit_count), observedLimit);
          const used = Math.max(Number(counter.dispatch_count), observed, localUsed);
          const production = Number(counter.production_count) + Math.max(0, used - Number(counter.dispatch_count));
          const test = Number(counter.test_count);
          const policy = clientId === 'test' ? this.testPolicies[provider] : null;
          const testBlocked = clientId === 'test' && (!policy
            || test + 1 > policy.cap || used + 1 > Math.max(0, limit - policy.reserve));
          if (used + 1 > limit || testBlocked) {
            blocked = true;
            candidateBlockedReason = clientId === 'test' && !policy ? 'test_policy' : 'quota';
            const resetAt = observationCurrent(observation, now) && observation.reset_at
              ? new Date(observation.reset_at) : nextReset(window.period, Number(window.timezone_offset || 0), now);
            candidateBlockedUntil = Math.max(candidateBlockedUntil, resetAt.getTime());
            continue;
          }
          counters.push({ window, start, limit, used, production, test });
        }
        if (blocked) {
          blockedReason = candidateBlockedReason;
          const candidate = candidateBlockedUntil ? new Date(candidateBlockedUntil).toISOString() : null;
          if (candidate && (!nextAvailableAt || candidate < nextAvailableAt)) nextAvailableAt = candidate;
          continue;
        }
        for (const counter of counters) {
          await database.prepare(`UPDATE credential_broker_quota_counters SET limit_count=?,dispatch_count=?,
              production_count=?,test_count=?,updated_at=?
            WHERE scope_id=? AND service=? AND period=? AND period_start=?`).bind(
            counter.limit, counter.used + 1,
            counter.production + (clientId === 'production' ? 1 : 0),
            counter.test + (clientId === 'test' ? 1 : 0), nowIso,
            counter.window.scope_id, counter.window.service, counter.window.period, counter.start
          ).run();
        }
        const usageDates = new Set([
          periodStart('day', Number(row.quota_timezone_offset || 0), now),
          periodStart('month', Number(row.quota_timezone_offset || 0), now)
        ]);
        await database.prepare(`INSERT INTO provider_usage_daily(credential_id,usage_date,accepted_count,rejected_count)
          VALUES (?,?,0,1) ON CONFLICT(credential_id,usage_date) DO UPDATE SET
          rejected_count=provider_usage_daily.rejected_count+1`)
          .bind(row.id, periodStart('day', Number(row.quota_timezone_offset || 0), now)).run();
        for (const start of usageDates) {
          await database.prepare(`INSERT INTO provider_usage_periods(credential_id,period_start,accepted_count,rejected_count)
            VALUES (?,?,0,1) ON CONFLICT(credential_id,period_start) DO UPDATE SET
            rejected_count=provider_usage_periods.rejected_count+1`).bind(row.id, start).run();
        }
        await database.prepare("UPDATE provider_credentials SET last_used_at=?,status='healthy',updated_at=? WHERE id=?")
          .bind(nowIso, nowIso, row.id).run();
        const dispatch = await database.prepare(`INSERT INTO credential_broker_dispatches(
            request_key,credential_id,status,reserved_at
          ) VALUES (?,?,'dispatched',?) RETURNING id`).bind(requestKey, row.id, nowIso).first();
        return { credential: { id: row.id, secret }, dispatchId: dispatch.id };
      }
      return { credential: null, reason: blockedReason, nextAvailableAt };
    });
  }

  async report({ dispatchId, outcome, retryAt = null }) {
    await this.database.transaction(async (database) => {
      const dispatch = await database.prepare(`SELECT dispatch.*,credential.*,
          dispatch.id AS dispatch_id,dispatch.status AS dispatch_status
        FROM credential_broker_dispatches dispatch JOIN provider_credentials credential
          ON credential.id=dispatch.credential_id WHERE dispatch.id=? FOR UPDATE`)
        .bind(dispatchId).first();
      if (!dispatch || dispatch.dispatch_status !== 'dispatched') return;
      const now = this.now();
      const nowIso = now.toISOString();
      const success = outcome === 'success';
      await database.prepare(`UPDATE credential_broker_dispatches SET status=?,outcome=?,completed_at=? WHERE id=?`)
        .bind(success ? 'success' : 'rejected', outcome, nowIso, dispatchId).run();
      if (success) {
        const day = periodStart('day', Number(dispatch.quota_timezone_offset || 0), new Date(dispatch.reserved_at));
        const starts = new Set([day,
          periodStart('month', Number(dispatch.quota_timezone_offset || 0), new Date(dispatch.reserved_at))]);
        await database.prepare(`UPDATE provider_usage_daily SET accepted_count=accepted_count+1,
          rejected_count=CASE WHEN rejected_count>0 THEN rejected_count - 1 ELSE 0 END
          WHERE credential_id=? AND usage_date=?`)
          .bind(dispatch.credential_id, day).run();
        for (const start of starts) {
          await database.prepare(`UPDATE provider_usage_periods SET accepted_count=accepted_count+1,
            rejected_count=CASE WHEN rejected_count>0 THEN rejected_count - 1 ELSE 0 END
            WHERE credential_id=? AND period_start=?`)
            .bind(dispatch.credential_id, start).run();
        }
        await database.prepare(`UPDATE provider_credentials SET status='healthy',failure_count=0,cooldown_until=NULL,
          last_success_at=?,updated_at=? WHERE id=?`).bind(nowIso, nowIso, dispatch.credential_id).run();
        return;
      }
      const failures = Number(dispatch.failure_count || 0) + 1;
      const reportedRetry = retryAt && Number.isFinite(Date.parse(retryAt)) ? new Date(retryAt) : null;
      const cooldown = reportedRetry && reportedRetry > now ? reportedRetry
        : outcome === 'quota' ? nextReset(dispatch.quota_period, Number(dispatch.quota_timezone_offset || 0), now)
          : new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** Math.min(failures, 8)));
      const status = outcome === 'auth' ? 'needs_review'
        : outcome === 'quota' ? 'quota_exhausted' : outcome === 'request' ? 'healthy' : 'cooldown';
      await database.prepare(`UPDATE provider_credentials SET status=?,failure_count=?,cooldown_until=?,
        last_failure_at=?,updated_at=? WHERE id=?`).bind(
        status, failures, status === 'healthy' ? null : cooldown.toISOString(), nowIso, nowIso, dispatch.credential_id
      ).run();
      if (outcome === 'quota') {
        const windows = (await database.prepare(`SELECT service,period,limit_count,timezone_offset
          FROM provider_quota_windows WHERE credential_id=? AND enabled=1`)
          .bind(dispatch.credential_id).all()).results;
        const effectiveWindows = windows.length ? windows : [{
          service: dispatch.quota_service,
          period: dispatch.quota_period,
          limit_count: dispatch.quota_limit,
          timezone_offset: dispatch.quota_timezone_offset
        }];
        for (const window of effectiveWindows) {
          const resetAt = reportedRetry && reportedRetry > now
            ? reportedRetry : nextReset(window.period, Number(window.timezone_offset || 0), now);
          await database.prepare(`INSERT INTO provider_quota_observations(
              credential_id,service,period,used_count,limit_count,reset_at,observed_at,source
            ) VALUES (?,?,?,?,?,?,?,'provider') ON CONFLICT(credential_id,service,period) DO UPDATE SET
              used_count=excluded.used_count,limit_count=excluded.limit_count,reset_at=excluded.reset_at,
              observed_at=excluded.observed_at,source='provider'`).bind(
            dispatch.credential_id, window.service, window.period, window.limit_count,
            window.limit_count, resetAt.toISOString(), nowIso
          ).run();
        }
      }
    });
  }

  async finishRequest(requestKey, { status, responseStatus = null, errorCode = null }) {
    const now = this.now().toISOString();
    await this.database.prepare(`UPDATE credential_broker_requests SET status=?,response_status=?,error_code=?,
      completed_at=?,updated_at=? WHERE id=? AND status='pending'`)
      .bind(status, responseStatus, errorCode, now, now, requestKey).run();
  }

  async repairStaleRequests() {
    const cutoff = new Date(this.now().getTime() - this.staleMs).toISOString();
    const now = this.now().toISOString();
    await this.database.transaction(async (database) => {
      await database.prepare(`UPDATE credential_broker_dispatches SET status='unknown',outcome='broker_crash',completed_at=?
        WHERE status='dispatched' AND reserved_at<=?`).bind(now, cutoff).run();
      await database.prepare(`UPDATE credential_broker_requests SET status='unknown',error_code='BROKER_OUTCOME_UNKNOWN',
        completed_at=?,updated_at=? WHERE status='pending' AND updated_at<=?`).bind(now, now, cutoff).run();
    });
  }
}

export { nextReset, periodStart };
