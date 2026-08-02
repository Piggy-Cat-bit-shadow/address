import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const compareSnapshots = (previous, current) => {
  const previousCounts = previous?.targetAddressCounts || {};
  const currentCounts = current?.targetAddressCounts || {};
  const ids = new Set([...Object.keys(previousCounts), ...Object.keys(currentCounts)]);
  let increased = 0;
  let decreased = 0;
  let unchanged = 0;
  for (const id of ids) {
    const before = Number(previousCounts[id] || 0);
    const after = Number(currentCounts[id] || 0);
    if (after > before) increased += 1;
    else if (after < before) decreased += 1;
    else unchanged += 1;
  }
  const previousTotal = Number(previous?.totalAddresses || 0);
  const currentTotal = Number(current?.totalAddresses || 0);
  const delta = currentTotal - previousTotal;
  const percent = previousTotal ? Number(((delta / previousTotal) * 100).toFixed(2)) : null;
  const shortage = (snapshot) => Object.values(snapshot?.targetAddressCounts || {}).filter((count) => Number(count) < 3).length;
  return {
    previousSnapshotId: previous?.snapshotId || null,
    currentSnapshotId: current?.snapshotId || null,
    previousTotal,
    currentTotal,
    delta,
    percent,
    targetsIncreased: increased,
    targetsDecreased: decreased,
    targetsUnchanged: unchanged,
    previousShortageTargets: shortage(previous),
    currentShortageTargets: shortage(current),
    warning: previousTotal > 0 && currentTotal < previousTotal * 0.6
  };
};

export const deltaMarkdown = (delta) => [
  '## Address Lite snapshot delta',
  '',
  '| Metric | Value |',
  '|---|---:|',
  `| Previous total | ${delta.previousTotal} |`,
  `| Current total | ${delta.currentTotal} |`,
  `| Delta | ${delta.delta >= 0 ? '+' : ''}${delta.delta}${delta.percent === null ? '' : ` (${delta.percent}%)`} |`,
  `| Targets increased | ${delta.targetsIncreased} |`,
  `| Targets decreased | ${delta.targetsDecreased} |`,
  `| Targets unchanged | ${delta.targetsUnchanged} |`,
  `| Previous shortage targets | ${delta.previousShortageTargets} |`,
  `| Current shortage targets | ${delta.currentShortageTargets} |`,
  '',
  ...(delta.warning ? ['> [!WARNING]', '> Total verified addresses fell by more than 40%. Verification remains authoritative; investigate source freshness.', ''] : [])
].join('\n');

const arg = (args, name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const current = JSON.parse(await readFile(resolve(arg(args, '--current')), 'utf8'));
  let previous = null;
  const previousPath = arg(args, '--previous');
  if (previousPath) previous = JSON.parse(await readFile(resolve(previousPath), 'utf8'));
  const result = compareSnapshots(previous, current);
  const jsonOutput = arg(args, '--json-output');
  if (jsonOutput) await writeFile(resolve(jsonOutput), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const markdown = deltaMarkdown(result);
  const summary = arg(args, '--summary', process.env.GITHUB_STEP_SUMMARY || '');
  if (summary) await writeFile(resolve(summary), `${markdown}\n`, { flag: 'a' });
  console.log(JSON.stringify(result));
}
