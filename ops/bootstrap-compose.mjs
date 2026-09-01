import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const secretRoot = process.env.ADDRESS_SECRET_ROOT || '/srv/address/data/secrets';
const legacyRoot = process.env.ADDRESS_LEGACY_SECRET_ROOT || '/srv/address/legacy-secrets';
const initialAdminPassword = process.env.ADMIN_INITIAL_PASSWORD ?? 'admin';
const initialFrontendPassword = process.env.FRONTEND_INITIAL_PASSWORD ?? '';

const validateInitialPassword = (name, value, allowDefault = false) => {
  if (allowDefault && value === 'admin') return;
  if (value.length < 10 || value.length > 512) {
    throw new Error(`${name} must contain 10 to 512 characters${allowDefault ? ' or equal admin' : ''}`);
  }
};

validateInitialPassword('ADMIN_INITIAL_PASSWORD', initialAdminPassword, true);
if (initialFrontendPassword) validateInitialPassword('FRONTEND_INITIAL_PASSWORD', initialFrontendPassword);

const definitions = [
  ['postgres_password', () => randomBytes(36).toString('base64url')],
  ['config_master_key', () => randomBytes(32).toString('base64')],
  ['admin_bootstrap_password', () => initialAdminPassword],
  ['frontend_bootstrap_password', () => initialFrontendPassword],
  ['sync_admin_token', () => randomBytes(36).toString('base64url')],
  ['credential_broker_production_token', () => randomBytes(36).toString('base64url')],
  ['credential_broker_test_token', () => randomBytes(36).toString('base64url')]
];

const readSecret = async (root, name) => {
  try {
    return (await readFile(join(root, name), 'utf8')).replace(/[\r\n]+$/u, '');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
};

const writeSecret = async (root, name, value) => {
  const target = join(root, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

await Promise.all([secretRoot, legacyRoot].map(async (root) => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
}));

for (const [name, create] of definitions) {
  const [current, legacy] = await Promise.all([readSecret(secretRoot, name), readSecret(legacyRoot, name)]);
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new Error(`Secret conflict for ${name}; reconcile data/secrets and config/secrets before starting`);
  }
  const value = current ?? legacy ?? create();
  if (current === undefined) await writeSecret(secretRoot, name, value);
  if (legacy === undefined) await writeSecret(legacyRoot, name, value);
}

console.log('Compose bootstrap completed');
