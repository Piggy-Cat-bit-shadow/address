import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiExample, publicApiEndpoints, publicOpenApiDocument } from '../src/domain/api-contract';
import { apiScopeForPath } from '../server/control/admin-api';

describe('public API contract', () => {
  it('covers every documented public business endpoint and keeps limits accurate', () => {
    expect(publicApiEndpoints.map(({ path }) => path)).toEqual([
      '/api/v1/health', '/api/v1/ready', '/api/v1/countries', '/api/v1/availability',
      '/api/v1/client-context', '/api/v1/locations/search', '/api/v1/generate',
      '/api/v1/generate/batch', '/api/v1/locations/hierarchy', '/api/v1/coverage',
      '/api/v1/addresses/{id}', '/api/v1/address-translation', '/api/v1/data-health'
    ]);
    const locations = publicApiEndpoints.find(({ id }) => id === 'locations')!;
    expect(locations.parameters.find(({ name }) => name === 'limit')).toMatchObject({ minimum: 20, maximum: 200, defaultValue: '100' });
    expect(JSON.stringify(publicApiEndpoints)).not.toContain('limit=20000');
    const generate = publicApiEndpoints.find(({ id }) => id === 'generate')!;
    expect(generate.parameters.map(({ name }) => name)).toEqual(expect.arrayContaining(['districtId', 'q', 'strategy', 'residential']));
    const batch = publicApiEndpoints.find(({ id }) => id === 'generate-batch')!;
    expect(batch.parameters.find(({ name }) => name === 'count')).toMatchObject({ minimum: 1, maximum: 50 });
  });

  it('generates curl, Python, JavaScript, and OpenAPI from the same catalog', () => {
    const generate = publicApiEndpoints.find(({ id }) => id === 'generate')!;
    expect(apiExample(generate, 'curl')).toContain('Authorization: Bearer YOUR_API_TOKEN');
    expect(apiExample(generate, 'python')).toContain('urlopen(request)');
    expect(apiExample(generate, 'javascript')).toContain('await fetch');
    expect(Object.keys(publicOpenApiDocument.paths)).toEqual(publicApiEndpoints.map(({ path }) => path));
    expect(JSON.stringify(publicOpenApiDocument)).not.toContain('YOUR_API_TOKEN');
  });

  it('uses generate scope for generation and translation while publishing only safe unauthenticated routes', () => {
    expect(apiScopeForPath('/api/v1/generate')).toBe('generate');
    expect(apiScopeForPath('/api/v1/generate/batch')).toBe('generate');
    expect(apiScopeForPath('/api/v1/address-translation')).toBe('generate');
    expect(apiScopeForPath('/api/v1/countries')).toBe('read');
    const server = readFileSync('server/api/server.ts', 'utf8');
    expect(server).toContain("'/api/v1/health', '/api/v1/ready', '/api/v1/openapi.json'");
  });

  it('omits the removed API hero copy and uses readable method labels', () => {
    const page = readFileSync('src/pages/[locale]/api.astro', 'utf8');
    const styles = readFileSync('src/styles/global.css', 'utf8');
    expect(page).not.toContain('<span class="api-version">API v1</span>');
    expect(page).not.toContain('<p>{copy.intro}</p>');
    expect(styles).toMatch(/\.api-method[^}]*font-size:\s*13px/u);
  });

  it('keeps all localized endpoint summaries free of replacement characters', () => {
    for (const endpoint of publicApiEndpoints) {
      expect(Object.values(endpoint.summary)).toHaveLength(9);
      expect(Object.values(endpoint.summary).every((value) => value.length > 10 && !value.includes('\uFFFD'))).toBe(true);
    }
  });
});
