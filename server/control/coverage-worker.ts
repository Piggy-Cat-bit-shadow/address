import { parentPort, workerData } from 'node:worker_threads';
import { createPostgresPool, PostgresDatabase } from '../database/postgres.mjs';
import { refreshAddressCoverage } from './coverage';

const pool = createPostgresPool({ connectionString: String(workerData.postgresUrl), max: 4, min: 1 });
const database = new PostgresDatabase(pool);
try {
  await refreshAddressCoverage(database);
  parentPort?.postMessage({ success: true });
} finally {
  await pool.end();
}
