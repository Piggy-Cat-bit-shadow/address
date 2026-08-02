import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimeMetrics } from './time-metrics.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const at = args.indexOf('--metrics');
const metricsRoot = resolve(at >= 0 ? args[at + 1] : resolve(root, '.lite-artifacts/metrics'));
const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
const files = await readdir(metricsRoot).catch(() => []);
const timeByGroup = new Map();
for (const name of files.filter((name) => /^time-.+\.log$/u.test(name))) {
  const group = name.replace(/^time-/, '').replace(/\.log$/, '');
  const text = await readFile(resolve(metricsRoot, name), 'utf8');
  timeByGroup.set(group, parseTimeMetrics(text));
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
const jobs = [...new Set(rows.map((row) => row.group))].map((group) => {
  const members = rows.filter((row) => row.group === group);
  return {
    group,
    targets: members.map((row) => row.targetId),
    wallClockMs: Math.max(0, ...members.map((row) => Number(row.wallClockMs || 0))),
    peakRssMiB: Math.max(0, ...members.map((row) => Number(row.peakRssMiB || 0)))
  };
});
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  targets: rows.length,
  matrixGroups: new Set(rows.map((row) => row.group)).size,
  staticAddresses: rows.reduce((sum, row) => sum + row.staticAddresses, 0),
  shortageTargets: rows.filter((row) => row.staticAddresses < 3).length,
  totalSourceBytesReported: [...bytesByGroup.values()].reduce((sum, value) => sum + value, 0),
  maxPeakRssMiB: Math.max(0, ...rows.map((row) => row.peakRssMiB || 0)),
  totalJobWallClockMs: jobs.reduce((sum, job) => sum + job.wallClockMs, 0),
  top10SlowestJobs: [...jobs].sort((left, right) => right.wallClockMs - left.wallClockMs || left.group.localeCompare(right.group)).slice(0, 10),
  top10PeakMemoryJobs: [...jobs].sort((left, right) => right.peakRssMiB - left.peakRssMiB || left.group.localeCompare(right.group)).slice(0, 10),
  jobs,
  rows
};
await writeFile(resolve(metricsRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
const columns = ['targetId','country','group','category','scope','retryTier','candidateTarget','candidateLimit','sourceSamplePercent','acceptedByImporter','rejectedByImporter','validationSuccessRate','staticAddresses','postcodeSlots','sourceBytes','sourceSizeEstimateMethod','estimatedStoragePeakMiB','storageAfterImportMiB','targetElapsedMs','peakRssMiB','wallClockMs'];
const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => JSON.stringify(row[column] ?? '')).join(','))].join('\n');
await writeFile(resolve(metricsRoot, 'summary.csv'), `${csv}\n`, 'utf8');
console.log(`[address-lite] metrics summary targets=${summary.targets} groups=${summary.matrixGroups} maxPeakRssMiB=${summary.maxPeakRssMiB}`);
