import { describe, expect, it } from 'vitest';
import { emptyResidentialFailure, emptyResidentialMetrics } from '../scripts/lite/failure-policy.mjs';

describe('Address Lite failure policy', () => {
  it('continues retries only for strict zero-result residential validation', () => {
    const first = Object.assign(new Error('Shard lite-de-bus-t0 produced no valid addresses'), {
      code: 'SOURCE_QUALITY_FAILED', rejectionReasons: { missing_postcode: 61 }
    });
    const second = Object.assign(new Error('Shard lite-es-ceu-t0 produced no valid addresses'), {
      code: 'SOURCE_QUALITY_FAILED', rejectionReasons: { missing_residential_evidence: 48 }
    });
    const error = new AggregateError([first, second], 'Address sync failed');

    expect(emptyResidentialFailure(error)).toBe(true);
    expect(emptyResidentialMetrics(error)).toEqual({ acceptedCount: 0, rejectedCount: 109 });
  });

  it('does not hide source, network, storage, or unexpected quality failures', () => {
    expect(emptyResidentialFailure(Object.assign(new Error('download failed'), { code: 'SYNC_FAILED' }))).toBe(false);
    expect(emptyResidentialFailure(Object.assign(new Error('quality regression'), { code: 'SOURCE_QUALITY_FAILED' }))).toBe(false);
  });
});
