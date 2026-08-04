import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { initializePostgres, PostgresDatabase, postgresPoolOptions } from '../server/database/postgres.mjs';

describe('PostgreSQL database adapter', () => {
  it('skips repeated schema DDL when both schemas are current', async () => {
    const query = vi.fn(async () => ({
      rows: [{ address_version: 7, control_version: 9 }], fields: [], rowCount: 1
    }));
    const release = vi.fn();
    await initializePostgres({ connect: async () => ({ query, release }) });
    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses a configurable high but finite pool ceiling', () => {
    expect(postgresPoolOptions({}).max).toBe(64);
    expect(postgresPoolOptions({ POSTGRES_POOL_MAX: '512' }).max).toBe(512);
    expect(postgresPoolOptions({ POSTGRES_POOL_MAX: '9999' }).max).toBe(64);
  });

  it('ships native PostgreSQL schemas', async () => {
    for (const file of ['server/database/schema.sql', 'server/control/schema.sql']) {
      const schema = await readFile(file, 'utf8');
      expect(schema).not.toMatch(/PRAGMA|CREATE VIRTUAL|AUTOINCREMENT|COLLATE NOCASE|json_valid|INSERT OR IGNORE/iu);
      expect(schema).toContain('ON CONFLICT');
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS');
    }
    const addressSchema = await readFile('server/database/schema.sql', 'utf8');
    expect(addressSchema).toContain("native_name='Fryslân'");
    expect(addressSchema).toContain("generate_series(1, 7)");
  });

  it('rewrites parameters without changing quoted question marks', async () => {
    const query = vi.fn(async () => ({ rows: [{ marker: '?' }], fields: [{ name: 'marker' }], rowCount: 1 }));
    const database = new PostgresDatabase({ query });
    await database.prepare("SELECT marker FROM item WHERE id=? AND marker='?'").bind('row-1').all();
    expect(query).toHaveBeenCalledWith("SELECT marker FROM item WHERE id=$1 AND marker='?'", ['row-1']);
  });

  it('uses explicit PostgreSQL conflict handling', async () => {
    const query = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const database = new PostgresDatabase({ query });
    await database.prepare('INSERT INTO item(id) VALUES (?) ON CONFLICT (id) DO NOTHING').bind('row-1').run();
    expect(query).toHaveBeenCalledWith('INSERT INTO item(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', ['row-1']);
  });

  it('isolates a transaction connection from unrelated asynchronous reads', async () => {
    const poolQuery = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const clientQuery = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const client = { query: clientQuery, release: vi.fn() };
    const database = new PostgresDatabase({ query: poolQuery, connect: async () => client });
    let releaseOutside;
    const outside = new Promise((resolve) => { releaseOutside = resolve; })
      .then(() => database.prepare('SELECT 2').all());

    await database.transaction(async () => {
      await database.prepare('SELECT 1').all();
      releaseOutside();
      await outside;
    });

    expect(clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(clientQuery).toHaveBeenCalledWith('SELECT 1', []);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(poolQuery).toHaveBeenCalledWith('SELECT 2', []);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
