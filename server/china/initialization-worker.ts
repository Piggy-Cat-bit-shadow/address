import { Buffer } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';
import { createPostgresPool, PostgresDatabase } from '../database/postgres.mjs';
import { ControlStore } from '../control/store';
import { ChinaDataService } from './service';

interface InitializationWorkerData {
  postgresUrl: string;
  masterKey: Uint8Array;
  dataRoot: string;
}

const data = workerData as InitializationWorkerData;
const postgresPool = createPostgresPool({
  connectionString: data.postgresUrl,
  max: 8,
  min: 1,
  application_name: 'address-china-initialization'
});
const addressDb = new PostgresDatabase(postgresPool);
const controlDb = new PostgresDatabase(postgresPool);
const control = new ControlStore(controlDb, Buffer.from(data.masterKey));

try {
  await new ChinaDataService(addressDb, control, data.dataRoot).initializeTargets({ scheduleContinuation: false });
  parentPort?.postMessage({ type: 'done' });
} catch (error) {
  parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
} finally {
  addressDb.close();
  controlDb.close();
  await postgresPool.end();
}
