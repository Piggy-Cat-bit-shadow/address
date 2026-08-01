import { describe, expect, it } from 'vitest';
import { parseElapsed, parseTimeMetrics } from '../scripts/lite/time-metrics.mjs';

describe('Address Lite time metrics', () => {
  it('preserves minute and hour components from GNU time output', () => {
    expect(parseElapsed('5:59.03')).toBe(359030);
    expect(parseElapsed('1:02:03.50')).toBe(3723500);
  });

  it('parses elapsed time without greedily consuming time separators', () => {
    const metrics = parseTimeMetrics(`\n\tElapsed (wall clock) time (h:mm:ss or m:ss): 12:15.90\n\tMaximum resident set size (kbytes): 9396808\n`);
    expect(metrics).toEqual({ peakRssKiB: 9396808, peakRssMiB: 9177, wallClockMs: 735900 });
  });
});
