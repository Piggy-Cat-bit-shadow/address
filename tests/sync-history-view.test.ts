import { describe, expect, it } from 'vitest';
import { syncHistoryGoalChange, syncHistoryResultDetail } from '../src/components/SyncAdmin';

const goals = (covered: number, qualified: number) => ({
  total: { current: 20_000, target: 20_000, met: true },
  administrativeCoverage: { actual: 90, target: 90, met: true, covered, total: 200 },
  regionalMinimums: {
    actual: 80, target: 100, met: false,
    lowest: { level: 3, minimum: 5, total: 200, covered, qualified, coverageRatio: 90, floorRatio: 40 },
    level1: null, level2: null, overrides: { satisfied: 0, total: 0, met: true }
  }
});

const historyItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'sync-fixture', kind: 'address-pool', countryCode: 'JP', sourceId: 'japan-abr-residential',
  trigger: 'queue', status: 'running', createdAt: '2026-08-07T00:00:00Z', startedAt: '2026-08-07T00:00:00Z',
  completedAt: null, heartbeatAt: null, deadlineAt: null, beforeCount: 19_533, afterCount: null, netGrowth: null,
  errorCode: null, errorMessage: null, ...overrides
}) as Parameters<typeof syncHistoryGoalChange>[0];

describe('sync history presentation', () => {
  it('does not invent negative goal changes for a running task without a final snapshot', () => {
    const item = historyItem({ beforeGoals: goals(146, 64), afterGoals: null });
    expect(syncHistoryGoalChange(item, 'zh-CN')).toBe('');
  });

  it('shows completed goal progress even when total address growth is zero', () => {
    const item = historyItem({
      status: 'succeeded', completedAt: '2026-08-07T00:05:00Z', afterCount: 19_533, netGrowth: 0,
      beforeGoals: goals(146, 64), afterGoals: goals(150, 67)
    });
    expect(syncHistoryGoalChange(item, 'zh-CN')).toBe('覆盖节点 +4 · 达标节点 +3');
  });

  it('labels accepted candidates as quality-passed records rather than net growth', () => {
    const item = historyItem({ candidateCount: 2_500, acceptedCount: 2_000, rejectedCount: 500 });
    expect(syncHistoryResultDetail(item, 'zh-CN')).toBe('候选 2,500 · 质量通过 2,000 · 拒绝 500');
    expect(syncHistoryResultDetail(item, 'en')).toBe('Candidates 2,500 · Quality passed 2,000 · Rejected 500');
  });
});
