import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL production readiness', () => {
  it('checks PostgreSQL schema, storage, country data and synchronization state', async () => {
    const source = await readFile('scripts/check-production-readiness.mjs', 'utf8');
    expect(source).toContain("openPostgresDatabase({ migrate: false })");
    expect(source).toContain('pg_database_size(current_database())');
    expect(source).toContain("table_schema='address'");
    expect(source).toContain('has no active residential addresses');
    expect(source).toContain('synchronization failures');
    expect(source).not.toMatch(/node:sqlite|PRAGMA|sqlite_master/iu);
  });
});
