import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflow = await readFile(new URL('../.github/workflows/address-lite.yml', import.meta.url), 'utf8');
describe('Address Lite workflow architecture', () => {
  it('keeps source refresh as one native sequential job', () => { const source = workflow.slice(workflow.indexOf('  source-refresh:'), workflow.indexOf('  data-assemble:')); expect(source).toContain('build-native.mjs'); expect(source).not.toContain('strategy:'); expect(source).not.toContain('matrix:'); expect(source).not.toContain('npm ci'); expect(source).not.toContain('cache: npm'); expect(workflow).not.toContain('POSTGRES_URL'); expect(workflow).not.toContain('setup-python'); });
  it('does not route active Lite workflow through server/database or server/sync', () => { const active = workflow.slice(workflow.indexOf('jobs:')); expect(active).not.toMatch(/server\/(database|sync)/); });
});
