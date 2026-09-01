import { describe, expect, it } from 'vitest';
import { nextMonitorTrail, type CoverageNode } from '../src/components/PublicMonitor';

const node = (key: string, countryCode: string, level: number): CoverageNode => ({
  key,
  countryCode,
  level,
  levelLabel: '',
  regionCode: '',
  regionName: key,
  residentialCount: 1,
  totalCount: 1,
  childCount: 1,
  updatedAt: ''
});

describe('public monitor navigation', () => {
  it('replaces the trail when a country is selected repeatedly or switched', () => {
    const ru = node('RU', 'RU', 0);
    const ca = node('CA', 'CA', 0);

    expect(nextMonitorTrail([ru, node('RU-1', 'RU', 1)], ru)).toEqual([ru]);
    expect(nextMonitorTrail([ru], ca)).toEqual([ca]);
  });

  it('replaces same-level regions and keeps only their ancestors', () => {
    const country = node('RU', 'RU', 0);
    const first = node('RU-1', 'RU', 1);
    const second = node('RU-2', 'RU', 1);
    const city = node('RU-2-1', 'RU', 2);

    expect(nextMonitorTrail([country, first], second)).toEqual([country, second]);
    expect(nextMonitorTrail([country, second], city)).toEqual([country, second, city]);
    expect(nextMonitorTrail([country, second, city], second)).toEqual([country, second]);
  });
});
