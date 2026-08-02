import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = await readFile(resolve(root, '.github/workflows/address-lite.yml'), 'utf8');
const bootstrap = await readFile(resolve(root, 'ops/address-lite/bootstrap-vps.sh'), 'utf8');
const nginxExample = await readFile(resolve(root, 'ops/address-lite/nginx.conf.example'), 'utf8');
const documentation = await readFile(resolve(root, 'docs/ADDRESS-LITE.md'), 'utf8');
const legacySecretPrefix = ['VP', 'S_'].join('');

describe('Address Lite generic remote deployment', () => {
  it('uses only abstract deployment secrets and requires pinned host keys', () => {
    for (const name of [
      'DEPLOY_HOST',
      'DEPLOY_USER',
      'DEPLOY_SSH_KEY',
      'DEPLOY_PORT',
      'DEPLOY_ROOT',
      'DEPLOY_KNOWN_HOSTS',
    ]) {
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }

    expect(workflow).not.toContain(legacySecretPrefix);
    expect(workflow).not.toMatch(/root="\$\{DEPLOY_ROOT:-[^}]+\}"/u);
    expect(workflow).not.toMatch(/ssh-keysc[a]n/u);
    expect(workflow).toContain('-o StrictHostKeyChecking=yes');
    expect(workflow).toContain('UserKnownHostsFile=$known_hosts');
  });

  it('requires all non-port deployment values before connecting', () => {
    const readiness = workflow.match(/if \[\[ -n "\$DEPLOY_HOST"[^\n]+/u)?.[0] ?? '';
    for (const name of ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY', 'DEPLOY_ROOT', 'DEPLOY_KNOWN_HOSTS']) {
      expect(readiness).toContain(`-n "$${name}"`);
    }
    expect(workflow).toContain('Deployment secrets are not fully configured; deployment is skipped.');
    expect(workflow).toContain('port="${DEPLOY_PORT:-22}"');
    expect(workflow).toContain('root="$DEPLOY_ROOT"');
  });

  it('cleans local credentials and remote temporary files on exit', () => {
    expect(workflow).toContain('trap cleanup_local_credentials EXIT');
    expect(workflow).toContain('rm -rf -- "$credential_dir"');
    expect(workflow).toContain('chmod 600 "$private_key"');
    expect(workflow).toContain('trap cleanup_remote_files EXIT');
    expect(workflow).toContain('rm -f -- "$archive" "$checksum"');
    expect(workflow).not.toMatch(/^\s*set -x\s*$/mu);
    expect(workflow).not.toMatch(/^\s*(?:env|printenv)\s*$/mu);
  });

  it('keeps checksum, safe extraction, validation, and atomic release switching', () => {
    expect(workflow.match(/sha256sum -c/gmu)).toHaveLength(2);
    expect(workflow).toContain('set -euo pipefail');
    expect(workflow).toContain('umask 022');
    expect(workflow).toContain('tar --no-same-owner -xzf "$archive" -C "$incoming"');
    expect(workflow).toContain('test -s "$incoming/index.html"');
    expect(workflow).toContain('test -s "$incoming/data/countries.json"');
    expect(workflow).toContain('mv "$incoming" "$final"');
    expect(workflow).toContain('ln -sfn "releases/$RELEASE" "$ROOT/current.next"');
    expect(workflow).toContain('mv -Tf "$ROOT/current.next" "$ROOT/current"');
  });

  it('protects the active release while retaining recent commit releases', () => {
    expect(workflow).toContain('active_release="$(basename "$(readlink "$ROOT/current")")"');
    expect(workflow).toContain('declare -A keep_releases=(["$active_release"]=1)');
    expect(workflow).toContain('${formal_releases[@]:0:3}');
    expect(workflow).toContain('rm -rf -- "$ROOT/releases/$release_dir"');
  });

  it('keeps opt-in manual deploys and the every-two-month schedule without a push trigger', () => {
    expect(workflow).not.toMatch(/^  push:/mu);
    expect(workflow).toMatch(/^  workflow_dispatch:/mu);
    expect(workflow).toMatch(/^  schedule:/mu);
    expect(workflow).toContain("if: ${{ github.event_name == 'schedule' || inputs.deploy == true }}");
    expect(workflow).toContain("default: false");
    expect(workflow).toContain("cron: '17 3 1 1,3,5,7,9,11 *'");
    expect(workflow).toContain('environment: address-lite-production');
  });

  it('requires an explicit generic bootstrap root and owner', () => {
    expect(bootstrap).toContain('bootstrap-vps.sh <web-root> <owner>');
    expect(bootstrap).toContain('if [[ $# -ne 2 || -z "$1" || -z "$2" ]]');
    expect(bootstrap).toContain('ROOT="$1"');
    expect(bootstrap).toContain('OWNER="$2"');
    expect(nginxExample).toContain('/path/to/static-site/current');
  });

  it('documents only the generic non-root deployment model', () => {
    expect(documentation).toContain('## Generic remote static deployment');
    expect(documentation).toContain('dedicated non-root deployment account');
    expect(documentation).toContain('does not need `sudo` or root SSH');
    expect(documentation).toContain('pinned `DEPLOY_KNOWN_HOSTS`');
    expect(documentation).not.toContain(legacySecretPrefix);
  });
});
