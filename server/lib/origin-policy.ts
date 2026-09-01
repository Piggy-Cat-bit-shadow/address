export type AllowedOrigins = '*' | string[];

const normalizeOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

export const parseAllowedOrigins = (...values: Array<string | undefined>): AllowedOrigins => {
  const configured = values.find((value) => value?.trim())?.trim() || '*';
  const entries = configured.split(',').map((value) => value.trim()).filter(Boolean);
  if (entries.includes('*')) {
    if (entries.length !== 1) throw new Error('ALLOWED_ORIGINS cannot combine * with explicit origins');
    return '*';
  }
  const origins = entries.map((value) => {
    const origin = normalizeOrigin(value);
    if (!origin) throw new Error(`Invalid allowed origin: ${value}`);
    return origin;
  });
  if (!origins.length) return '*';
  return [...new Set(origins)];
};

export const originAllowed = (allowed: AllowedOrigins, value: string | null): boolean => {
  if (allowed === '*') return true;
  if (!value) return false;
  const origin = normalizeOrigin(value);
  return Boolean(origin && allowed.includes(origin));
};
