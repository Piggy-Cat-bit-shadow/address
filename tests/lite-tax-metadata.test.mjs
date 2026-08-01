import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateManifest } from '../scripts/lite/check-config.mjs';
import { formatTaxReference, taxTypeLabels } from '../src/components/LiteApp.tsx';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
const temporaryDirectories = [];
const cloneManifest = () => structuredClone(manifest);
const target = (value, id) => value.targets.find((entry) => entry.id === id);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Address Lite structured tax metadata', () => {
  it('requires valid tax metadata on every low-tax target and forbids it on major cities', () => {
    const result = validateManifest(manifest);
    const lowTaxTargets = manifest.targets.filter((entry) => entry.category === 'low_tax');
    const majorCities = manifest.targets.filter((entry) => entry.category === 'major_city');

    expect(result.errors).toEqual([]);
    expect(lowTaxTargets).toHaveLength(19);
    expect(lowTaxTargets.every((entry) => entry.tax?.rate.startsWith('≈'))).toBe(true);
    expect(majorCities.every((entry) => !Object.hasOwn(entry, 'tax'))).toBe(true);
  });

  it('rejects missing low-tax metadata and tax metadata on a major city', () => {
    const missing = cloneManifest();
    delete target(missing, 'US-DE').tax;
    expect(validateManifest(missing).errors).toContain('US-DE: low_tax target requires tax metadata');

    const misplaced = cloneManifest();
    target(misplaced, 'US-NYC').tax = structuredClone(target(misplaced, 'US-DE').tax);
    expect(validateManifest(misplaced).errors).toContain('US-NYC: major_city target must not define tax metadata');
  });

  it('rejects unsupported tax types and rates without the approximation marker', () => {
    const invalidType = cloneManifest();
    target(invalidType, 'US-DE').tax.type = 'sales_tax';
    expect(validateManifest(invalidType).errors).toContain('US-DE: invalid tax type sales_tax');

    const exactRate = cloneManifest();
    target(exactRate, 'US-DE').tax.rate = '0%';
    expect(validateManifest(exactRate).errors).toContain('US-DE: tax rate must be a non-empty string starting with ≈');
  });

  it('provides bilingual type labels and concise localized references', () => {
    const delawareTax = target(manifest, 'US-DE').tax;
    expect(taxTypeLabels.en.tax_free).toBe('Tax-free state / territory');
    expect(taxTypeLabels['zh-CN'].tax_free).toBe('免税州 / 地区');
    expect(taxTypeLabels.en.major_city).toBeUndefined();
    expect(formatTaxReference(delawareTax, 'en')).toBe('≈ 0% Sales Tax · General rate');
    expect(formatTaxReference(delawareTax, 'zh-CN')).toBe('≈ 0% Sales Tax · 一般税');
  });

  it('passes tax metadata into countries.json without adding it to major cities', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'address-lite-tax-'));
    temporaryDirectories.push(directory);
    const input = resolve(directory, 'input');
    const output = resolve(directory, 'output');

    for (const entry of manifest.targets) {
      const file = resolve(input, entry.file);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ stats: { addresses: 0, postcodes: 0 } })}\n`, 'utf8');
    }

    await execFileAsync(process.execPath, [resolve(root, 'scripts/lite/aggregate.mjs'), '--input', input, '--output', output]);
    const index = JSON.parse(await readFile(resolve(output, 'countries.json'), 'utf8'));
    const indexedTargets = index.countries.flatMap((country) => country.targets);

    expect(indexedTargets.find((entry) => entry.id === 'US-DE').tax).toEqual(target(manifest, 'US-DE').tax);
    expect(indexedTargets.find((entry) => entry.id === 'US-NYC')).not.toHaveProperty('tax');
  });

  it('keeps the two category entries independent and gates the tax panel to low-tax targets', async () => {
    const source = await readFile(resolve(root, 'src/components/LiteApp.tsx'), 'utf8');
    expect(source).toContain("setCategory('low_tax')");
    expect(source).toContain("setCategory('major_city')");
    expect(source).toContain("category === 'low_tax' && target?.tax");
    expect(source).not.toContain('target?.note &&');
  });
});
