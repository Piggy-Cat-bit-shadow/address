import { Buffer } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';
import { createPostgresPool, PostgresDatabase } from '../database/postgres.mjs';
import { ControlStore } from '../control/store';
import { ChinaDataService, type ChinaWorkerData, type ChinaWorkerMessage } from './service';

const data = workerData as ChinaWorkerData;
const postgresPool = createPostgresPool({
  connectionString: data.postgresUrl,
  max: 8,
  min: 1,
  application_name: 'address-china-worker'
});
const addressDb = new PostgresDatabase(postgresPool);
const controlDb = new PostgresDatabase(postgresPool);
const control = new ControlStore(controlDb, Buffer.from(data.masterKey));
const updateRun = control.updateRun.bind(control);
control.updateRun = async (id, status, progress, error) => {
  await updateRun(id, status, progress, error);
  parentPort?.postMessage({ type: 'progress', progress: { ...progress, runId: id, status } } satisfies ChinaWorkerMessage);
};
parentPort?.on('message', (message: { type?: string }) => {
  if (message?.type === 'stop') process.exit(0);
});
parentPort?.unref();
try {
  const result = await new ChinaDataService(addressDb, control, data.dataRoot)
    .runSync(data.runId, data.targets, data.providers);
  parentPort?.postMessage({ type: 'done', ...result } satisfies ChinaWorkerMessage);
} finally {
  addressDb.close();
  controlDb.close();
  await postgresPool.end();
}
