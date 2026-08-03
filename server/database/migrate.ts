import { openRuntimeDatabases } from './runtime';

const databases = await openRuntimeDatabases();
await databases.close();
