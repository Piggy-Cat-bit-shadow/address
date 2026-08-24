import { openRuntimeDatabases } from './runtime';
import { ensureLocationCatalog } from './bootstrap';
import { applyAdministrativeCatalogOverrides } from './administrative-catalog-overrides';
import { refreshResidentialCoverage } from './residential-coverage.mjs';
import { reconcilePublishedPool } from './published-pool.mjs';
import { refreshStaleAddressGenerationIndexes } from './generation-index.mjs';

const databases = await openRuntimeDatabases();
await refreshStaleAddressGenerationIndexes(databases.address);
await ensureLocationCatalog(databases.address);
if (await applyAdministrativeCatalogOverrides(databases.address)) {
  await refreshResidentialCoverage(databases.address, 'HK');
}
const reconciled = await reconcilePublishedPool(databases.address, ['HK']);
for (const result of reconciled) {
  if (result.before !== result.after) {
    await refreshResidentialCoverage(databases.address, result.countryCode);
  }
}
await databases.close();
