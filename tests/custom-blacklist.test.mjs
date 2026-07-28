import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { customBlacklistKeywords, matchesCustomBlacklist, replaceCustomBlacklist } from '../server/lib/custom-blacklist.mjs';

const directory = resolve('data', 'test-fixtures');
const file = resolve(directory, `blacklist-${process.pid}.txt`);
mkdirSync(directory, { recursive: true });
const originalPath = process.env.ADDRESS_BLACKLIST_FILE;

afterEach(() => {
  if (originalPath === undefined) delete process.env.ADDRESS_BLACKLIST_FILE;
  else process.env.ADDRESS_BLACKLIST_FILE = originalPath;
  rmSync(file, { force: true });
});

describe('custom blacklist keyword file', () => {
  it('parses keywords, skips comments, matches case-insensitively and hot-reloads on mtime change', () => {
    process.env.ADDRESS_BLACKLIST_FILE = file;
    writeFileSync(file, '# comment\n\n消防救援\nPolice Academy\n', 'utf8');
    utimesSync(file, new Date(), new Date(1_000_000_000_000));
    expect(customBlacklistKeywords(Date.now() + 60_000)).toEqual(['消防救援', 'police academy']);
    expect(matchesCustomBlacklist(['临沂市消防救援支队'])).toBe('消防救援');
    expect(matchesCustomBlacklist(['12 POLICE ACADEMY ROAD'])).toBe('police academy');
    expect(matchesCustomBlacklist(['幸福家园12栋'])).toBeNull();

    writeFileSync(file, '监控测试关键词\n', 'utf8');
    utimesSync(file, new Date(), new Date(1_100_000_000_000));
    expect(customBlacklistKeywords(Date.now() + 120_000)).toEqual(['监控测试关键词']);
  });

  it('returns no keywords when the file is missing', () => {
    process.env.ADDRESS_BLACKLIST_FILE = resolve(directory, `missing-${process.pid}.txt`);
    expect(customBlacklistKeywords(Date.now() + 240_000)).toEqual([]);
    expect(matchesCustomBlacklist(['任意地址'])).toBeNull();
  });

  it('atomically replaces and normalizes administrator keywords', () => {
    process.env.ADDRESS_BLACKLIST_FILE = file;
    expect(replaceCustomBlacklist([' 宠物医院 ', 'PET SHOP', '宠物医院'])).toEqual(['宠物医院', 'pet shop']);
    expect(customBlacklistKeywords(Date.now() + 60_000)).toEqual(['宠物医院', 'pet shop']);
    expect(matchesCustomBlacklist(['幸福宠物医院'])).toBe('宠物医院');
    expect(() => replaceCustomBlacklist(['x'.repeat(81)])).toThrow('INVALID_BLACKLIST_KEYWORDS');
  });
});
