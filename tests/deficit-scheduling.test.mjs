import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { isCountryDue } from '../server/sync/country-plan.mjs';

const HOURS = 60 * 60 * 1000;
const now = new Date('2026-08-02T12:00:00Z');
const entryAt = (hoursAgo, extra = {}) => ({
  status: 'imported',
  lastSuccessfulAt: new Date(now.getTime() - hoursAgo * HOURS).toISOString(),
  ...extra
});

test('countries at target keep the source cadence', () => {
  assert.equal(isCountryDue(entryAt(29 * 24), 30, now), false);
  assert.equal(isCountryDue(entryAt(31 * 24), 30, now), true);
});

test('below-target countries become due daily', () => {
  assert.equal(isCountryDue(entryAt(26, { countryBelowTarget: true }), 30, now), true);
  assert.equal(isCountryDue(entryAt(20, { countryBelowTarget: true }), 30, now), false);
});

test('below-floor countries become due daily', () => {
  assert.equal(isCountryDue(entryAt(26, { countryBelowFloor: true }), 30, now), true);
  assert.equal(isCountryDue(entryAt(20, { countryBelowFloor: true }), 30, now), false);
});

test('failed shards stay due immediately', () => {
  assert.equal(isCountryDue({ status: 'failed' }, 30, now), true);
});

test('missing history is always due', () => {
  assert.equal(isCountryDue(undefined, 30, now), true);
});
