import { openRuntimeDatabases } from './runtime';
import { ensureLocationCatalog } from './bootstrap';

const databases = await openRuntimeDatabases();
await ensureLocationCatalog(databases.address);
await databases.close();
