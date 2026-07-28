import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const RELOAD_INTERVAL_MS = 10_000;

const cache = { path: '', mtimeMs: -1, checkedAt: 0, keywords: [] };

const normalizeKeyword = (value) => value.normalize('NFKC').toLocaleLowerCase('und').trim();

const parseKeywords = (content) => content
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map(normalizeKeyword)
  .filter(Boolean);

const validatedKeywords = (values) => {
  if (!Array.isArray(values) || values.length > 500) throw new Error('INVALID_BLACKLIST_KEYWORDS');
  const keywords = values.map((value) => normalizeKeyword(String(value || '')))
    .filter(Boolean);
  if (keywords.some((value) => value.length > 80 || /[\r\n]/u.test(value) || value.startsWith('#'))) {
    throw new Error('INVALID_BLACKLIST_KEYWORDS');
  }
  return [...new Set(keywords)];
};

export const customBlacklistPath = () =>
  resolve(process.env.ADDRESS_BLACKLIST_FILE || 'data/blacklist.txt');

export const customBlacklistKeywords = (now = Date.now()) => {
  const path = customBlacklistPath();
  if (cache.path === path && now - cache.checkedAt < RELOAD_INTERVAL_MS) return cache.keywords;
  cache.checkedAt = now;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache.path = path;
    cache.mtimeMs = 0;
    cache.keywords = [];
    return cache.keywords;
  }
  if (cache.path === path && cache.mtimeMs === mtimeMs) return cache.keywords;
  try {
    cache.keywords = parseKeywords(readFileSync(path, 'utf8'));
  } catch {
    cache.keywords = [];
  }
  cache.path = path;
  cache.mtimeMs = mtimeMs;
  return cache.keywords;
};

export const matchesCustomBlacklist = (values) => {
  const keywords = customBlacklistKeywords();
  if (!keywords.length) return null;
  for (const value of values) {
    if (!value) continue;
    const haystack = normalizeKeyword(String(value));
    if (!haystack) continue;
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) return keyword;
    }
  }
  return null;
};

export const replaceCustomBlacklist = (values) => {
  const keywords = validatedKeywords(values);
  const path = customBlacklistPath();
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  const header = '# Custom address exclusion keywords. One keyword per line.\n';
  writeFileSync(temporary, `${header}${keywords.join('\n')}${keywords.length ? '\n' : ''}`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  cache.path = '';
  cache.mtimeMs = -1;
  cache.checkedAt = 0;
  cache.keywords = [];
  return customBlacklistKeywords(Date.now() + RELOAD_INTERVAL_MS);
};
