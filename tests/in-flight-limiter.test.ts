import { describe, expect, it } from 'vitest';
import { InFlightLimiter, isGenerationPath } from '../server/api/in-flight-limiter';

describe('InFlightLimiter', () => {
  it('rejects acquisitions at the configured limit and recovers after release', () => {
    const limiter = new InFlightLimiter(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.activeCount).toBe(2);
    limiter.release();
    expect(limiter.activeCount).toBe(1);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('does not underflow when released while idle', () => {
    const limiter = new InFlightLimiter(1);
    limiter.release();
    expect(limiter.activeCount).toBe(0);
  });

  it('recognizes both public API path forms used by the gateway', () => {
    expect(isGenerationPath('/api/v1/generate')).toBe(true);
    expect(isGenerationPath('/api/v1/generate/batch')).toBe(true);
    expect(isGenerationPath('/v1/generate')).toBe(true);
    expect(isGenerationPath('/api/v1/countries')).toBe(false);
  });
});
