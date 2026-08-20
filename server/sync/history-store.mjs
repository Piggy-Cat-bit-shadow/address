import { evaluateCountryGoals } from './country-goals.mjs';

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);
const json = (value) => JSON.stringify(value || {});

export class SyncHistoryStore {
  constructor(database, { catalogShards = async () => [], now = () => new Date() } = {}) {
    this.database = database;
    this.catalogShards = catalogShards;
    this.now = now;
  }

  async selectedSources(shards) {
    const catalog = await this.catalogShards();
    const requested = new Set((shards || ['all']).map((value) => String(value).toLowerCase()));
    const all = requested.has('all');
    const selected = catalog.filter((shard) => all || requested.has(String(shard.id).toLowerCase())
      || requested.has(String(shard.countryCode).toLowerCase()));
    const values = new Map();
    for (const shard of selected) values.set(`${shard.countryCode}:${shard.id}`, {
      countryCode: shard.countryCode,
      sourceId: shard.id
    });
    for (const value of requested) {
      if (/^[a-z]{2}$/u.test(value) && value !== 'cn'
        && ![...values.values()].some((entry) => entry.countryCode === value.toUpperCase())) {
        values.set(`${value.toUpperCase()}:`, { countryCode: value.toUpperCase(), sourceId: '' });
      }
    }
    return [...values.values()];
  }

  async goalSnapshots(countryCodes) {
    const goals = await evaluateCountryGoals(this.database);
    return new Map(countryCodes.map((countryCode) => {
      const goal = goals.get(countryCode);
      return [countryCode, goal ? { count: goal.current, goals: goal.rules } : { count: 0, goals: {} }];
    }));
  }

  async queued(job) {
    const now = this.now().toISOString();
    const sources = await this.selectedSources(job.shards);
    const snapshots = await this.goalSnapshots([...new Set(sources.map((source) => source.countryCode))]);
    await this.database.prepare(`INSERT INTO sync_runs(
      id,kind,target_json,status,progress_json,created_at,updated_at
    ) VALUES (?, 'address-pool', ?, 'queued', '{}', ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(
      job.id, json({ trigger: job.trigger, shards: job.shards }), now, now
    ).run();
    for (const source of sources) {
      const before = snapshots.get(source.countryCode) || { count: 0, goals: {} };
      await this.database.prepare(`INSERT INTO sync_run_countries(
        run_id,country_code,source_id,trigger_name,status,before_count,before_goals_json,
        source_fingerprint,source_version_before,adapter_revision,created_at,updated_at
      ) VALUES (?,?,?,?, 'queued', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id,country_code,source_id) DO NOTHING`).bind(
        job.id, source.countryCode, source.sourceId, job.trigger, before.count, json(before.goals),
        job.sourceFingerprints?.[source.sourceId] || null,
        job.sourceInputs?.[source.sourceId]?.sourceVersion || null,
        job.sourceInputs?.[source.sourceId]?.adapterRevision || null,
        now, now
      ).run();
    }
  }

  async started(job) {
    const now = this.now().toISOString();
    await this.database.prepare(`UPDATE sync_runs SET status='running',started_at=COALESCE(started_at,?),
      progress_json=?,updated_at=? WHERE id=?`).bind(now, json({ phase: job.phase, ...(job.progress || {}) }), now, job.id).run();
    await this.database.prepare(`UPDATE sync_run_countries SET status='running',started_at=COALESCE(started_at,?),
      heartbeat_at=?,deadline_at=?,updated_at=? WHERE run_id=?`).bind(
      job.startedAt || now, job.heartbeatAt || now, job.deadlineAt, now, job.id
    ).run();
  }

  async heartbeat(job) {
    const now = this.now().toISOString();
    await this.database.prepare(`UPDATE sync_runs SET progress_json=?,updated_at=? WHERE id=?`)
      .bind(json({ phase: job.phase, ...(job.progress || {}), heartbeatAt: job.heartbeatAt, deadlineAt: job.deadlineAt }), now, job.id).run();
    await this.database.prepare(`UPDATE sync_run_countries SET heartbeat_at=?,deadline_at=?,updated_at=? WHERE run_id=?`)
      .bind(job.heartbeatAt || now, job.deadlineAt, now, job.id).run();
    await this.schedulerHeartbeat(job.id, job.heartbeatAt || now);
  }

  async completed(job) {
    const now = this.now().toISOString();
    const status = terminalStatuses.has(job.status) ? job.status : 'failed';
    const rows = (await this.database.prepare(`SELECT country_code,source_id,before_count,before_goals_json
      FROM sync_run_countries WHERE run_id=? ORDER BY country_code,source_id`)
      .bind(job.id).all()).results;
    const snapshots = await this.goalSnapshots([...new Set(rows.map((row) => String(row.country_code)))]);
    const actualShards = new Set((job.actualShards || job.shards || []).map(String));
    const outcomes = new Map((job.sourceOutcomes || []).map((outcome) => [String(outcome.shardId || outcome.shardKey || ''), outcome]));
    const executedByCountry = new Map();
    for (const row of rows) {
      if (!actualShards.size || actualShards.has(String(row.source_id))) {
        executedByCountry.set(row.country_code, (executedByCountry.get(row.country_code) || 0) + 1);
      }
    }
    await this.database.prepare(`UPDATE sync_runs SET status=?,progress_json=?,error_code=?,error_message=?,failure_phase=?,
      completed_at=?,updated_at=? WHERE id=?`).bind(
      status, json({ phase: job.phase, releaseId: job.releaseId || null }), job.errorCode || null,
      job.error || null, job.failurePhase || null, job.completedAt || now, now, job.id
    ).run();
    for (const row of rows) {
      const countryCode = String(row.country_code);
      const sourceId = String(row.source_id || '');
      const after = snapshots.get(countryCode) || { count: 0, goals: {} };
      const executed = !actualShards.size || actualShards.has(sourceId);
      const outcome = outcomes.get(sourceId);
      const outcomeFailed = ['failed', 'source-quality-failed'].includes(String(outcome?.status || ''));
      const outcomeSkipped = ['deferred', 'not-due', 'disabled'].includes(String(outcome?.status || ''));
      const childStatus = !executed || outcomeSkipped ? 'cancelled' : outcomeFailed ? 'failed' : status;
      const singleSourceCountry = executedByCountry.get(countryCode) === 1;
      const errorCode = !executed ? 'SYNC_SOURCE_NOT_EXECUTED'
        : outcomeSkipped ? 'SYNC_SOURCE_SKIPPED' : outcome?.errorCode || (childStatus === 'failed' ? job.errorCode || null : null);
      const errorMessage = !executed || outcomeSkipped ? null
        : outcome?.error || (childStatus === 'failed' ? job.error || null : null);
      const metrics = outcome?.metrics && typeof outcome.metrics === 'object' ? outcome.metrics : {};
      await this.database.prepare(`UPDATE sync_run_countries SET status=?,completed_at=?,heartbeat_at=?,failure_phase=?,
        after_count=?,net_growth=?,after_goals_json=?,candidate_count=?,accepted_count=?,rejected_count=?,
        rejection_reasons_json=?,metrics_json=?,source_complete=?,source_version_after=?,checkpoint_token=?,error_code=?,error_message=?,updated_at=?
        WHERE run_id=? AND country_code=? AND source_id=?`).bind(
        childStatus, job.completedAt || now, job.heartbeatAt || now, outcome?.failurePhase || job.failurePhase || null,
        executed ? after.count : row.before_count,
        executed && singleSourceCountry ? after.count - Number(row.before_count || 0) : null,
        executed ? json(after.goals) : row.before_goals_json || '{}',
        Number.isFinite(Number(metrics.candidateCount)) ? Number(metrics.candidateCount) : null,
        Number.isFinite(Number(outcome?.acceptedCount)) ? Number(outcome.acceptedCount) : null,
        Number.isFinite(Number(outcome?.rejectedCount)) ? Number(outcome.rejectedCount) : null,
        json(outcome?.rejectionReasons), json(metrics), outcome?.sourceComplete === false ? 0 : 1,
        outcome?.sourceVersion || null, outcome?.checkpointToken || null,
        errorCode, errorMessage, now, job.id, countryCode, sourceId
      ).run();
    }
    await this.database.prepare(`UPDATE sync_scheduler_state SET active_run_id=NULL,heartbeat_at=?,updated_at=?
      WHERE scheduler_id='address-sync' AND active_run_id=?`).bind(now, now, job.id).run();
  }

  async pendingSourceStateApplications() {
    return (await this.database.prepare(`SELECT run_id,country_code,source_id,status,completed_at,net_growth,
      before_goals_json,after_goals_json,source_complete,source_fingerprint,
      source_version_before,source_version_after,adapter_revision,checkpoint_token,
      error_code,error_message,failure_phase,metrics_json
      FROM sync_run_countries
      WHERE trigger_name='queue' AND status IN ('succeeded','failed') AND source_id<>''
        AND source_state_applied_at IS NULL
      ORDER BY completed_at,run_id,country_code,source_id`).all()).results;
  }

  async markSourceStateApplied({ runId, countryCode, sourceId, appliedAt = this.now().toISOString() }) {
    return this.database.prepare(`UPDATE sync_run_countries SET source_state_applied_at=?,updated_at=?
      WHERE run_id=? AND country_code=? AND source_id=? AND source_state_applied_at IS NULL`)
      .bind(appliedAt, appliedAt, runId, countryCode, sourceId).run();
  }

  async pauseForQuota({ runId, countryCode, sourceId } = {}) {
    const now = this.now().toISOString();
    return this.database.prepare(`UPDATE sync_run_countries SET status='paused_quota',updated_at=?
      WHERE run_id=? AND country_code=? AND source_id=? AND status IN ('failed','running')`)
      .bind(now, runId, String(countryCode || '').toUpperCase(), String(sourceId || '')).run();
  }

  async repairQuotaWait({ countryCode, sourceId } = {}) {
    const country = String(countryCode || '').toUpperCase();
    const source = String(sourceId || '');
    const row = await this.database.prepare(`SELECT run_id FROM sync_run_countries
      WHERE country_code=? AND source_id=? AND status='failed'
        AND error_code='SOURCE_CREDENTIAL_UNAVAILABLE'
      ORDER BY created_at DESC LIMIT 1`).bind(country, source).first();
    if (!row?.run_id) return null;
    return this.pauseForQuota({ runId: row.run_id, countryCode: country, sourceId: source });
  }

  async schedulerHeartbeat(activeRunId = null, at = this.now().toISOString()) {
    if (activeRunId) {
      await this.database.prepare(`INSERT INTO sync_scheduler_state(
        scheduler_id,heartbeat_at,last_planned_at,active_run_id,updated_at
      ) VALUES ('address-sync',?,?,?,?) ON CONFLICT(scheduler_id) DO UPDATE SET
        heartbeat_at=excluded.heartbeat_at,last_planned_at=excluded.last_planned_at,
        active_run_id=excluded.active_run_id,updated_at=excluded.updated_at`).bind(at, at, activeRunId, at).run();
      return;
    }
    await this.database.prepare(`INSERT INTO sync_scheduler_state(
      scheduler_id,heartbeat_at,last_planned_at,active_run_id,updated_at
    ) VALUES ('address-sync',?,?,NULL,?) ON CONFLICT(scheduler_id) DO UPDATE SET
      heartbeat_at=excluded.heartbeat_at,last_planned_at=excluded.last_planned_at,
      updated_at=excluded.updated_at`).bind(at, at, at).run();
  }

  async repairInterruptedRuns() {
    const current = this.now();
    const now = current.toISOString();
    const staleBefore = new Date(current.getTime() - 2 * 60 * 60_000).toISOString();
    const runs = (await this.database.prepare(`SELECT id FROM sync_runs
      WHERE status IN ('queued','running') AND updated_at<?`)
      .bind(staleBefore).all()).results;
    for (const run of runs) {
      await this.database.prepare(`UPDATE sync_run_countries SET status='failed',completed_at=?,heartbeat_at=?,
        net_growth=NULL,error_code='SYNC_JOB_INTERRUPTED',error_message='Synchronization interrupted before completion',
        failure_phase='interrupted',updated_at=?
        WHERE run_id=? AND status IN ('queued','running')`).bind(now, now, now, run.id).run();
      await this.database.prepare(`UPDATE sync_runs SET status='failed',error_code='SYNC_JOB_INTERRUPTED',
        error_message='Synchronization interrupted before completion',failure_phase='interrupted',completed_at=?,updated_at=? WHERE id=?`)
        .bind(now, now, run.id).run();
      await this.database.prepare(`UPDATE sync_scheduler_state SET active_run_id=NULL,heartbeat_at=?,updated_at=?
        WHERE scheduler_id='address-sync' AND active_run_id=?`).bind(now, now, run.id).run();
    }
    return runs.length;
  }

  async repairLegacyProjections() {
    let runs;
    try {
      runs = (await this.database.prepare(`SELECT run.id,run.started_at,run.completed_at,run.error_message
        FROM sync_runs run
        WHERE run.kind='address-pool' AND run.target_json LIKE '%"shards":["all"]%'
          AND run.started_at IS NOT NULL AND run.completed_at IS NOT NULL`).all()).results;
    } catch {
      return 0;
    }
    let repaired = 0;
    for (const run of runs) {
      const children = (await this.database.prepare(`SELECT source_id,error_message FROM sync_run_countries
        WHERE run_id=?`).bind(run.id).all()).results;
      const actual = (await this.database.prepare(`SELECT DISTINCT child.source_id
        FROM sync_run_countries child JOIN sync_shard_state shard ON shard.shard_id=child.source_id
        WHERE child.run_id=? AND shard.updated_at>=? AND shard.updated_at<=?`).bind(
        run.id, run.started_at, run.completed_at
      ).all()).results;
      let sourceId = actual.length === 1 ? String(actual[0].source_id) : '';
      if (!sourceId) {
        const errors = [run.error_message, ...children.map((child) => child.error_message)]
          .filter(Boolean).join('\n').toLowerCase();
        const matches = children.map((child) => String(child.source_id || ''))
          .filter((candidate) => candidate && errors.includes(candidate.toLowerCase()));
        const uniqueMatches = [...new Set(matches)];
        if (uniqueMatches.length === 1) sourceId = uniqueMatches[0];
      }
      if (!sourceId) continue;
      const result = await this.database.prepare(`UPDATE sync_run_countries SET status='cancelled',
        after_count=before_count,net_growth=NULL,after_goals_json=before_goals_json,
        error_code='SYNC_SOURCE_NOT_EXECUTED',error_message=NULL,updated_at=?
        WHERE run_id=? AND source_id<>? AND (error_code IS NULL OR error_code<>'SYNC_SOURCE_NOT_EXECUTED')`).bind(
        this.now().toISOString(), run.id, sourceId
      ).run();
      repaired += Number(result?.meta?.changes || result?.changes || 0);
    }
    return repaired;
  }
}
