import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../database/sqlite.mjs';
import { refreshAddressCoverage } from './coverage';

const database = openDatabase(String(workerData.databasePath), { timeout: 30_000 });
try {
  await refreshAddressCoverage(database);
  parentPort?.postMessage({ success: true });
} finally {
  database.close();
}
