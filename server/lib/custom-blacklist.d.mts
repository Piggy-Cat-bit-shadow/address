export function customBlacklistPath(): string;
export function customBlacklistKeywords(now?: number): string[];
export function matchesCustomBlacklist(values: unknown[]): string | null;
export function replaceCustomBlacklist(values: unknown[]): string[];
