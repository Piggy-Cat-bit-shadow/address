import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
const groups = new Map();
for (const target of manifest.targets) {
  const entry = groups.get(target.jobGroup) || { group: target.jobGroup, country: target.country, targets: 0 };
  if (entry.country !== target.country) throw new Error(`jobGroup ${target.jobGroup} mixes countries`);
  entry.targets += 1;
  groups.set(target.jobGroup, entry);
}
const include = [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
process.stdout.write(JSON.stringify({ include }));
