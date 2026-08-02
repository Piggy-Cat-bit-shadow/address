import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_DATA_ARCHIVE_BYTES, assertDataSizeBudget } from './snapshot.mjs';

export const MAX_SITE_ARCHIVE_BYTES = 5 * 1024 * 1024;

export const checkSizeBudget = async ({ dataArchive, siteArchive, dataRoot }) => {
  const result = {};
  if (dataArchive) {
    result.dataArchiveBytes = (await stat(dataArchive)).size;
    if (result.dataArchiveBytes > MAX_DATA_ARCHIVE_BYTES) throw new Error(`Verified Data Snapshot exceeds ${MAX_DATA_ARCHIVE_BYTES} bytes`);
  }
  if (siteArchive) {
    result.siteArchiveBytes = (await stat(siteArchive)).size;
    if (result.siteArchiveBytes > MAX_SITE_ARCHIVE_BYTES) throw new Error(`Site Artifact exceeds ${MAX_SITE_ARCHIVE_BYTES} bytes`);
  }
  if (dataRoot) {
    const data = await assertDataSizeBudget(dataRoot);
    result.largestTarget = { path: data.largestTargetPath, bytes: data.largestTargetBytes };
  }
  return result;
};

const arg = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? resolve(args[index + 1]) : undefined;
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  console.log(JSON.stringify(await checkSizeBudget({
    dataArchive: arg(args, '--data-archive'),
    siteArchive: arg(args, '--site-archive'),
    dataRoot: arg(args, '--data-root')
  })));
}
