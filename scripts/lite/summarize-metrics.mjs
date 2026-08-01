import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const at = args.indexOf('--metrics');
const metricsRoot = resolve(at >= 0 ? args[at + 1] : resolve(root, '.lite-artifacts/metrics'));
const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
const files = await readdir(metricsRoot).catch(() => []);
const timeByGroup = new Map();
const parseElapsed = (value) => {
  const parts = String(value || '').trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  return Math.round((parts[0] || 0) * 1000);
};
for (const name of files.filter((name) => /^time-.+\.log$/u.test(name))) {
  const group = name.replace(/^time-/, '').replace(/\.log$/, '');
  const text = await readFile(resolve(metricsRoot, name), 'utf8');
  const rss = text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/u);
  const elapsed = text.match(/Elapsed \(wall clock\) time.*:\s*([0-9:.]+)/u);
  timeByGroup.set(group, {
    peakRssKiB: rss ? Number(rss[1]) : null,
    peakRssMiB: rss ? Math.round(Number(rss[1]) / 1024) : null,
    wallClockMs: elapsed ? parseElapsed(elapsed[1]) : null
  });
}
const rows = [];
for (const target of manifest.targets) {
  const path = resolve(metricsRoot, `${target.id}.json`);
  let metric;
  try { metric = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
  const attempts = Number(metric.acceptedByImporter || 0) + Number(metric.rejectedByImporter || 0);
  rows.push({
    targetId: target.id,
    country: target.country,
    group: target.jobGroup,
    category: target.category,
    scope: target.scope,
    retryTier: Number(metric.retryTier || 0),
    candidateTarget: Number(metric.candidateTarget || 0),
    candidateLimit: Number(metric.candidateLimit || 0),
    sourceSamplePercent: Number(metric.sourceSamplePercent || 0),
    acceptedByImporter: Number(metric.acceptedByImporter || 0),
    rejectedByImporter: Number(metric.rejectedByImporter || 0),
    validationSuccessRate: attempts ? Number((Number(metric.acceptedByImporter || 0) / attempts).toFixed(4)) : null,
    staticAddresses: Number(metric.addresses || 0),
    postcodeSlots: Number(metric.postcodes || 0),
    sourceBytes: Number(metric.sourceBytes || 0),
    sourceSizeEstimateMethod: String(metric.sourceSizeEstimateMethod || ''),
    estimatedStoragePeakMiB: Number(metric.estimatedStoragePeakBytes || 0) / 1024 / 1024,
    storageAfterImportMiB: Number(metric.storageBytesAfterImport || 0) / 1024 / 1024,
    targetElapsedMs: Number(metric.elapsedMs || 0),
    ...(timeByGroup.get(target.jobGroup) || { peakRssKiB: null, peakRssMiB: null, wallClockMs: null })
  });
}
rows.sort((a, b) => (b.wallClockMs || b.targetElapsedMs) - (a.wallClockMs || a.targetElapsedMs) || a.targetId.localeCompare(b.targetId));
const bytesByGroup = new Map();
for (const row of rows) bytesByGroup.set(row.group, Math.max(bytesByGroup.get(row.group) || 0, row.sourceBytes || 0));
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  targets: rows.length,
  matrixGroups: new Set(rows.map((row) => row.group)).size,
  staticAddresses: rows.reduce((sum, row) => sum + row.staticAddresses, 0),
  totalSourceBytesReported: [...bytesByGroup.values()].reduce((sum, value) => sum + value, 0),
  maxPeakRssMiB: Math.max(0, ...rows.map((row) => row.peakRssMiB || 0)),
  rows
};
await writeFile(resolve(metricsRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
const columns = ['targetId','country','group','category','scope','retryTier','candidateTarget','candidateLimit','sourceSamplePercent','acceptedByImporter','rejectedByImporter','validationSuccessRate','staticAddresses','postcodeSlots','sourceBytes','sourceSizeEstimateMethod','estimatedStoragePeakMiB','storageAfterImportMiB','targetElapsedMs','peakRssMiB','wallClockMs'];
const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => JSON.stringify(row[column] ?? '')).join(','))].join('\n');
await writeFile(resolve(metricsRoot, 'summary.csv'), `${csv}\n`, 'utf8');
console.log(`[address-lite] metrics summary targets=${summary.targets} groups=${summary.matrixGroups} maxPeakRssMiB=${summary.maxPeakRssMiB}`);
