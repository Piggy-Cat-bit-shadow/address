import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const overlay = readFileSync('ops/docker-compose.production.yml', 'utf8');
const isolatedOverlay = readFileSync('ops/docker-compose.isolated.yml', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const deploy = readFileSync('ops/activate-production-release.sh', 'utf8');
const deployClient = readFileSync('ops/deploy.sh', 'utf8');
const gateway = readFileSync('ops/caddy/Caddyfile.template', 'utf8');

describe('production blue-green deployment', () => {
  it('keeps the isolated verification stack in a separate Compose project', () => {
    expect(isolatedOverlay).toMatch(/^name: address-test$/mu);
  });

  it('keeps blue and green application slots behind one stable gateway', () => {
    expect(overlay).toContain('127.0.0.1:20022:8080');
    expect(overlay).toMatch(/gateway:[\s\S]*?networks:\s*\n\s*- internal\s*\n\s*- egress/u);
    for (const slot of ['blue', 'green']) {
      expect(overlay).toContain(`api-${slot}:`);
      expect(overlay).toContain(`credential-broker-${slot}:`);
      expect(overlay).toContain(`profiles: [production-${slot}]`);
    }
    expect(gateway).toContain('reverse_proxy __API_UPSTREAM__');
    expect(gateway).toContain('reverse_proxy __BROKER_UPSTREAM__');
    expect(gateway).toContain('trusted_proxies static private_ranges');
    expect(gateway).toContain('trusted_proxies_strict');
  });

  it('migrates and verifies the inactive release before the atomic reload', () => {
    const migration = deploy.indexOf('compose run --rm --no-deps -T migrate');
    const slotHealth = deploy.indexOf('verify_slot "api-$TARGET_SLOT"');
    const reload = deploy.indexOf('caddy reload --config', slotHealth);
    expect(migration).toBeGreaterThan(0);
    expect(slotHealth).toBeGreaterThan(migration);
    expect(reload).toBeGreaterThan(slotHealth);
    expect(deploy).toContain('rollback_cutover');
    expect(deploy.indexOf('trap rollback_cutover ERR INT TERM')).toBeLessThan(migration);
    expect(deploy).toContain('local stop_timeout=30');
    expect(deploy).toContain('x-address-release: $RELEASE_ID');
  });

  it('serializes activations and never retries a partially completed cutover', () => {
    expect(deploy).toContain('flock -n 9');
    expect(deployClient).toContain('ssh_once "cd \'$ADDRESS_ROOT\' && bash ./ops/activate-production-release.sh');
    expect(deployClient).not.toContain('ssh_retry "cd \'$ADDRESS_ROOT\' && bash ./ops/activate-production-release.sh');
  });

  it('uses non-interactive public-key SSH with connection keepalives', () => {
    for (const option of [
      'PreferredAuthentications=publickey', 'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no', 'GSSAPIAuthentication=no',
      'ServerAliveInterval=15', 'ServerAliveCountMax=4'
    ]) expect(deployClient).toContain(option);
    expect(deployClient).toContain('"${SSH_OPTIONS[@]}"');
  });

  it('excludes tracked files deleted from the worktree when staging a release', () => {
    expect(deployClient).toContain('[[ -f "$file" || -L "$file" ]]');
  });

  it('uses a unique release archive path across concurrent deploy attempts', () => {
    expect(deployClient).toContain('TARBALL=$(mktemp "${TMPDIR:-/tmp}/address-$REL.XXXXXX.tar.gz")');
  });

  it('keeps sync singleton with enough time to finish a hard-timeout job', () => {
    expect(overlay.match(/stop_grace_period: 95m/gmu)).toHaveLength(2);
    expect(overlay.match(/^  sync:/gmu)).toHaveLength(1);
    expect(compose).toMatch(/sync:[\s\S]*?command: \[node, node_modules\/tsx\/dist\/cli\.mjs, server\/sync\/index\.mjs\]/u);
    expect(deploy).toContain('stop -t 5700');
    expect(deploy).toContain('compose up -d --no-deps --wait --wait-timeout 6000 sync');
  });

  it('uses an internal sync alias that cannot collide with the isolated stack on shared egress', () => {
    expect(compose).toMatch(/sync:[\s\S]*?aliases:\s*\n\s*- address-sync-control/u);
    expect(compose).toContain('SYNC_CONTROL_URL: http://address-sync-control:8791');
    expect(overlay.match(/SYNC_CONTROL_URL: http:\/\/address-sync-control:8791/gmu)).toHaveLength(3);
    expect(overlay).not.toContain('SYNC_CONTROL_URL: http://sync:8791');
  });

  it('stops obsolete single-instance application services after cutover', () => {
    const gatewayVerification = deploy.indexOf('x-address-release: $RELEASE_ID');
    const legacyCleanup = deploy.indexOf('for legacy_service in api credential-broker');
    expect(legacyCleanup).toBeGreaterThan(gatewayVerification);
    expect(deploy).toContain('compose stop -t 30 "$legacy_service"');
  });

  it('prunes only unreferenced releases after a successful deployment', () => {
    const syncReady = deploy.indexOf('compose up -d --no-deps --wait --wait-timeout 6000 sync');
    const cleanup = deploy.indexOf('cleanup_release_artifacts', syncReady);
    expect(cleanup).toBeGreaterThan(syncReady);
    expect(deploy).toContain('ADDRESS_RELEASE_RETENTION');
    expect(deploy).toContain('[[ "$protected" == *" $release "* ]]');
    expect(deploy).toContain('! -L "$target"');
  });
});
