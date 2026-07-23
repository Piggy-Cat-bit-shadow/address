import { describe, expect, it } from 'vitest';
import {
  countryCodeFrom,
  isPublicIpAddress,
  resolveInitialSelection
} from '../src/domain/client-context';

describe('client context selection', () => {
  it('uses a valid URL country and otherwise defaults to the United States', () => {
    expect(resolveInitialSelection({ urlCountry: 'jp' })).toMatchObject({ country: 'JP', source: 'url' });
    expect(resolveInitialSelection({ urlCountry: 'XX' })).toMatchObject({ country: 'US', source: 'default' });
    expect(resolveInitialSelection({})).toMatchObject({ country: 'US', source: 'default' });
  });

  it('normalizes only supported country codes', () => {
    expect(countryCodeFrom(' cn ')).toBe('CN');
    expect(countryCodeFrom('T1')).toBeUndefined();
    expect(countryCodeFrom(undefined)).toBeUndefined();
  });

  it('distinguishes public addresses from local and documentation ranges', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIpAddress('127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('192.168.1.1')).toBe(false);
    expect(isPublicIpAddress('203.0.113.10')).toBe(false);
    expect(isPublicIpAddress('2001:db8::1')).toBe(false);
  });
});
