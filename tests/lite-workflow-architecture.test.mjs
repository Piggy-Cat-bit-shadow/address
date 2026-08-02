import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = await readFile(resolve(root, '.github/workflows/address-lite.yml'), 'utf8');
const rollbackWorkflow = await readFile(resolve(root, '.github/workflows/address-lite-rollback.yml'), 'utf8');
const rollback = await readFile(resolve(root, 'ops/address-lite/rollback.sh'), 'utf8');

describe('Address Lite layered workflow architecture', () => {
  it('exposes only safe manual data and deployment controls', () => {
    expect(workflow).toContain('data_mode:');
    expect(workflow).toContain('          - auto');
    expect(workflow).toContain('          - refresh');
    expect(workflow).toContain('deploy:');
    expect(workflow).not.toMatch(/^  push:/mu);
    expect(workflow).toContain("cron: '17 3 1 1,3,5,7,9,11 *'");
  });

  it('keeps the four layers and the bounded strict Matrix', () => {
    for (const job of ['source-refresh:', 'data-assemble:', 'site-build:', 'release:', 'deploy:']) expect(workflow).toContain(`  ${job}`);
    expect(workflow).toContain('max-parallel: 6');
    expect(workflow).toContain("ADDRESS_SYNC_OVERTURE_BUILDINGS: 'true'");
    expect(workflow).toContain("ADDRESS_SYNC_REQUIRE_RESIDENTIAL: 'true'");
    expect(workflow).toContain("ADDRESS_SYNC_PREPARE_CONCURRENCY: '1'");
    expect(workflow).toContain("ADDRESS_SYNC_CPU_CONCURRENCY: '1'");
  });

  it('publishes verified artifacts with the required retention and provenance', () => {
    expect(workflow).toContain('name: address-lite-data');
    expect(workflow).toContain('name: address-lite-dist');
    expect(workflow).toContain('name: address-lite-site');
    expect(workflow).toContain('name: address-lite-metrics');
    for (const days of [90, 30, 3]) expect(workflow).toContain(`retention-days: ${days}`);
    expect(workflow).toContain('address-lite-data.tar.gz.sha256');
    expect(workflow).toContain('snapshot.json');
    expect(workflow).toContain('public/build-info.json');
  });

  it('pins every official Action to an immutable commit', () => {
    const uses = [...workflow.matchAll(/^\s*- uses:\s+(actions\/[^@\s]+)@([^\s]+)/gmu)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, , reference] of uses) expect(reference).toMatch(/^[0-9a-f]{40}$/u);
  });
});

describe('Address Lite standalone rollback', () => {
  it('is manual, protected, atomic, and validates retained releases', () => {
    expect(rollbackWorkflow).toContain('workflow_dispatch:');
    expect(rollbackWorkflow).toContain('environment: address-lite-production');
    expect(rollbackWorkflow).toContain("default: previous");
    expect(rollback).toContain("[[ \"$active_release\" =~ ^[0-9a-f]{12}$ ]]");
    expect(rollback).toContain('test -s "$ROOT/releases/$release/index.html"');
    expect(rollback).toContain('test -s "$ROOT/releases/$release/data/countries.json"');
    expect(rollback).toContain('test -s "$ROOT/releases/$release/build-info.json"');
    expect(rollback).toContain('ln -sfn "releases/$target" "$ROOT/current.next"');
    expect(rollback).toContain('mv -Tf "$ROOT/current.next" "$ROOT/current"');
    expect(rollback).not.toContain('sudo');
  });
});
