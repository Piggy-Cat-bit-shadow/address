import { describe, expect, it, vi } from 'vitest';
import { executeSqlStatements, splitSqlStatements } from '../scripts/sql-statements.mjs';

describe('catalog SQL statement execution', () => {
  it('splits statements without breaking quoted values or comments', () => {
    const source = `BEGIN;
      INSERT INTO examples(value) VALUES ('a; b'), ('it''s; valid');
      -- ignored ; delimiter
      /* nested ; /* still ignored ; */ done */
      DO $body$ BEGIN PERFORM ';'; END $body$;
      COMMIT;`;

    expect([...splitSqlStatements(source)]).toEqual([
      'BEGIN',
      "INSERT INTO examples(value) VALUES ('a; b'), ('it''s; valid')",
      "-- ignored ; delimiter\n      /* nested ; /* still ignored ; */ done */\n      DO $body$ BEGIN PERFORM ';'; END $body$",
      'COMMIT'
    ]);
  });

  it('sends each statement as a separate PostgreSQL command', async () => {
    const database = { exec: vi.fn(async () => undefined) };
    const completed = await executeSqlStatements(database, 'BEGIN; SELECT 1; SELECT 2; COMMIT;');

    expect(completed).toBe(4);
    expect(database.exec.mock.calls.map(([statement]) => statement)).toEqual([
      'BEGIN', 'SELECT 1', 'SELECT 2', 'COMMIT'
    ]);
  });

  it('stops before commit when a batch fails', async () => {
    const database = {
      exec: vi.fn(async (statement) => {
        if (statement === 'SELECT broken') throw new Error('failed');
      })
    };

    await expect(executeSqlStatements(database, 'BEGIN; SELECT 1; SELECT broken; COMMIT;'))
      .rejects.toThrow('failed');
    expect(database.exec.mock.calls.map(([statement]) => statement)).toEqual([
      'BEGIN', 'SELECT 1', 'SELECT broken'
    ]);
  });
});
