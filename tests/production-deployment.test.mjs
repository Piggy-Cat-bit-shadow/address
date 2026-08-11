import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const overlay = readFileSync('ops/docker-compose.production.yml', 'utf8');
const isolatedOverlay = readFileSync('ops/docker-compose.isolated.yml', 'utf8');
const deploy = readFileSync('ops/activate-production-release.sh', 'utf8');
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
    expect(deploy).toContain('x-address-release: $RELEASE_ID');
  });

  it('keeps sync singleton with enough time to finish a hard-timeout job', () => {
    expect(overlay.match(/stop_grace_period: 95m/gmu)).toHaveLength(2);
    expect(overlay.match(/^  sync:/gmu)).toHaveLength(1);
    expect(deploy).toContain('stop -t 5700');
    expect(deploy).toContain('compose up -d --no-deps --wait --wait-timeout 6000 sync');
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
