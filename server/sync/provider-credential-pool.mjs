import { createDecipheriv } from 'node:crypto';

const periodStart = (period, offsetMinutes, date = new Date()) => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000).toISOString();
  return period === 'month' ? shifted.slice(0, 7) : shifted.slice(0, 10);
};

const nextReset = (period, offsetMinutes, date = new Date()) => {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  if (period === 'month') shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  else shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
};

const masterKeyFrom = (value) => {
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

export class ProviderCredentialPool {
  constructor(database, masterKey) {
    this.database = database;
    this.masterKey = Buffer.isBuffer(masterKey) ? masterKey : masterKeyFrom(masterKey);
  }

  async quotaUsed(row, date = new Date()) {
    return Number(await this.database.prepare(`SELECT COALESCE(SUM(usage.accepted_count+usage.rejected_count),0) AS total
      FROM provider_credentials credential JOIN provider_usage_periods usage ON usage.credential_id=credential.id
      WHERE credential.quota_scope_id=? AND credential.quota_service=? AND usage.period_start=?`)
      .bind(row.quota_scope_id, row.quota_service, periodStart(row.quota_period, row.quota_timezone_offset, date))
      .first('total') || 0);
  }

  async acquire(provider, { excludeIds = [] } = {}) {
    const now = new Date();
    const nowIso = now.toISOString();
    await this.database.prepare(`UPDATE provider_credentials SET status='healthy',cooldown_until=NULL,
      provider_reported_used=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_used END,
      provider_reported_limit=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_limit END,
      provider_reported_reset_at=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_reset_at END,
      provider_reported_at=CASE WHEN status='quota_exhausted' THEN NULL ELSE provider_reported_at END,updated_at=?
      WHERE status IN ('cooldown','quota_exhausted') AND cooldown_until IS NOT NULL AND cooldown_until<=?`)
      .bind(nowIso, nowIso).run();
    const excluded = new Set(excludeIds);
    const rows = (await this.database.prepare(`SELECT * FROM provider_credentials
      WHERE provider=? AND enabled=1 AND status NOT IN ('disabled','needs_review')
      AND (cooldown_until IS NULL OR cooldown_until<=?)
      ORDER BY last_used_at IS NOT NULL,last_used_at,created_at,id`).bind(provider, nowIso).all()).results;
    for (const row of rows) {
      if (excluded.has(row.id)) continue;
      if (row.last_used_at && Date.parse(row.last_used_at) + 1000 / Number(row.qps_limit || 1) > now.getTime()) continue;
      const localUsed = await this.quotaUsed(row, now);
      const reportedCurrent = row.provider_reported_at
        && (!row.provider_reported_reset_at || Date.parse(row.provider_reported_reset_at) > now.getTime());
      const used = Math.max(localUsed, reportedCurrent ? Number(row.provider_reported_used || 0) : 0);
      const limit = reportedCurrent && row.provider_reported_limit !== null
        ? Number(row.provider_reported_limit) : Number(row.quota_limit);
      if (used >= limit) continue;
      try {
        const secret = decrypt(row, this.masterKey);
        await this.database.prepare("UPDATE provider_credentials SET last_used_at=?,status='healthy' WHERE id=?")
          .bind(nowIso, row.id).run();
        return { id: row.id, provider: row.provider, secret };
      } catch {
        await this.database.prepare("UPDATE provider_credentials SET status='needs_review',updated_at=? WHERE id=?")
          .bind(nowIso, row.id).run();
      }
    }
    return null;
  }

  async report(id, outcome, observation = {}) {
    const now = new Date();
    const nowIso = now.toISOString();
    const row = await this.database.prepare('SELECT * FROM provider_credentials WHERE id=?').bind(id).first();
    if (!row) return;
    const accepted = outcome === 'success' ? 1 : 0;
    await this.database.batch([
      this.database.prepare(`INSERT INTO provider_usage_daily(credential_id,usage_date,accepted_count,rejected_count)
        VALUES (?,?,?,?) ON CONFLICT(credential_id,usage_date) DO UPDATE SET
        accepted_count=provider_usage_daily.accepted_count+excluded.accepted_count,
        rejected_count=provider_usage_daily.rejected_count+excluded.rejected_count`)
        .bind(id, periodStart('day', row.quota_timezone_offset, now), accepted, accepted ? 0 : 1),
      this.database.prepare(`INSERT INTO provider_usage_periods(credential_id,period_start,accepted_count,rejected_count)
        VALUES (?,?,?,?) ON CONFLICT(credential_id,period_start) DO UPDATE SET
        accepted_count=provider_usage_periods.accepted_count+excluded.accepted_count,
        rejected_count=provider_usage_periods.rejected_count+excluded.rejected_count`)
        .bind(id, periodStart(row.quota_period, row.quota_timezone_offset, now), accepted, accepted ? 0 : 1)
    ]);
    if (outcome === 'success') {
      await this.database.prepare(`UPDATE provider_credentials SET status='healthy',failure_count=0,cooldown_until=NULL,
        last_success_at=?,updated_at=? WHERE id=?`).bind(nowIso, nowIso, id).run();
      return;
    }
    const failures = Number(row.failure_count || 0) + 1;
    const retryAt = observation.retryAt && Number.isFinite(Date.parse(observation.retryAt))
      ? new Date(observation.retryAt) : null;
    const cooldown = outcome === 'quota'
      ? retryAt && retryAt > now ? retryAt : nextReset(row.quota_period, row.quota_timezone_offset, now)
      : retryAt && retryAt > now ? retryAt
        : new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** Math.min(failures, 8)));
    const status = ['auth', 'invalid'].includes(outcome)
      ? 'needs_review' : outcome === 'quota' ? 'quota_exhausted' : 'cooldown';
    await this.database.prepare(`UPDATE provider_credentials SET status=?,failure_count=?,cooldown_until=?,
      last_failure_at=?,updated_at=?,provider_reported_used=CASE WHEN ?='quota' THEN quota_limit ELSE provider_reported_used END,
      provider_reported_limit=CASE WHEN ?='quota' THEN quota_limit ELSE provider_reported_limit END,
      provider_reported_reset_at=CASE WHEN ?='quota' THEN ? ELSE provider_reported_reset_at END,
      provider_reported_at=CASE WHEN ?='quota' THEN ? ELSE provider_reported_at END WHERE id=?`)
      .bind(status, failures, cooldown.toISOString(), nowIso, nowIso, outcome, outcome, outcome,
        cooldown.toISOString(), outcome, nowIso, id).run();
  }
}

export const createProviderCredentialPool = (database, environment = process.env) => {
  if (!database || !String(environment.CONFIG_MASTER_KEY || '').trim()) return null;
  return new ProviderCredentialPool(database, environment.CONFIG_MASTER_KEY);
};
