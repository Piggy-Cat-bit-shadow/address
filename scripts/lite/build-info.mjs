import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const createBuildInfo = ({ snapshot, siteSha, siteBuiltAt, dataMode }) => ({
  schemaVersion: 1,
  siteSha,
  siteBuiltAt: new Date(siteBuiltAt).toISOString(),
  dataSnapshotId: snapshot.snapshotId,
  dataSourceSha: snapshot.sourceSha,
  dataGeneratedAt: snapshot.generatedAt,
  dataMode,
  totalAddresses: Number(snapshot.totalAddresses),
  targetCount: Number(snapshot.targetCount),
  countryCount: Number(snapshot.countryCount)
});

const arg = (args, name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const snapshot = JSON.parse(await readFile(resolve(arg(args, '--snapshot')), 'utf8'));
  const output = resolve(arg(args, '--output', 'public/build-info.json'));
  const info = createBuildInfo({
    snapshot,
    siteSha: arg(args, '--site-sha'),
    siteBuiltAt: arg(args, '--site-built-at', new Date().toISOString()),
    dataMode: arg(args, '--data-mode')
  });
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(info));
}
