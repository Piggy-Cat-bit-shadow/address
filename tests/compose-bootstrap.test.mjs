import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots = [];

const runBootstrap = (root, environment = {}) => execute(process.execPath, ['ops/bootstrap-compose.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ADDRESS_SECRET_ROOT: join(root, 'data', 'secrets'),
    ADDRESS_LEGACY_SECRET_ROOT: join(root, 'config', 'secrets'),
    ...environment
  }
});

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Compose bootstrap', () => {
  it('creates persistent infrastructure secrets and configured initial passwords', async () => {
    const root = await mkdtemp(join(tmpdir(), 'address-compose-'));
    roots.push(root);
    await runBootstrap(root, {
      ADMIN_INITIAL_PASSWORD: 'custom administrator password',
      FRONTEND_INITIAL_PASSWORD: 'custom frontend password'
    });

    const names = [
      'postgres_password', 'config_master_key', 'admin_bootstrap_password', 'frontend_bootstrap_password',
      'sync_admin_token', 'credential_broker_production_token', 'credential_broker_test_token'
    ];
    for (const name of names) {
      const current = await readFile(join(root, 'data', 'secrets', name), 'utf8');
      const legacy = await readFile(join(root, 'config', 'secrets', name), 'utf8');
      expect(current).toBe(legacy);
    }
    expect(await readFile(join(root, 'data', 'secrets', 'admin_bootstrap_password'), 'utf8')).toBe('custom administrator password');
    expect(await readFile(join(root, 'data', 'secrets', 'frontend_bootstrap_password'), 'utf8')).toBe('custom frontend password');
    expect(Buffer.from(await readFile(join(root, 'data', 'secrets', 'config_master_key'), 'utf8'), 'base64')).toHaveLength(32);
  });

  it('uses admin with no frontend password by default and remains idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'address-compose-'));
    roots.push(root);
    await runBootstrap(root);
    const passwordFile = join(root, 'data', 'secrets', 'postgres_password');
    const password = await readFile(passwordFile, 'utf8');
    await runBootstrap(root, { ADMIN_INITIAL_PASSWORD: 'ignored after initialization' });
    expect(await readFile(passwordFile, 'utf8')).toBe(password);
    expect(await readFile(join(root, 'data', 'secrets', 'admin_bootstrap_password'), 'utf8')).toBe('admin');
    expect(await readFile(join(root, 'data', 'secrets', 'frontend_bootstrap_password'), 'utf8')).toBe('');
  });

  it('imports legacy secrets and rejects conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'address-compose-'));
    roots.push(root);
    const legacyRoot = join(root, 'config', 'secrets');
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(join(legacyRoot, 'postgres_password'), 'legacy-password');
    await runBootstrap(root);
    expect(await readFile(join(root, 'data', 'secrets', 'postgres_password'), 'utf8')).toBe('legacy-password');
    await writeFile(join(root, 'data', 'secrets', 'postgres_password'), 'conflicting-password');
    await expect(runBootstrap(root)).rejects.toMatchObject({ stderr: expect.stringContaining('Secret conflict for postgres_password') });
  });
});
