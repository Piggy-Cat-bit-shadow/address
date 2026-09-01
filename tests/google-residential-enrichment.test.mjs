import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateGoogleResidentialResult, reconcileGoogleProgressOutput, requestGoogleReverse, selectGoogleResidentialResult
} from '../server/sync/google-residential-enrichment.mjs';
import { executeOperation, operationDefinitions } from '../server/credential-broker/operations.mjs';

const seed = {
  building_id: 'way/123',
  building_class: 'apartments',
  latitude: 13.7563,
  longitude: 100.5018,
  ring: [
    [100.5017, 13.7562], [100.5019, 13.7562], [100.5019, 13.7564],
    [100.5017, 13.7564], [100.5017, 13.7562]
  ]
};

const response = (overrides = {}) => ({
  results: [{
    placeId: 'google-place-1',
    types: ['street_address'],
    addressComponents: [
      { longText: '99', shortText: '99', types: ['street_number'] },
      { longText: 'ถนนพระรามที่ 1', shortText: 'ถนนพระรามที่ 1', types: ['route'] },
      { longText: 'ปทุมวัน', shortText: 'ปทุมวัน', types: ['sublocality_level_1'] },
      { longText: 'กรุงเทพมหานคร', shortText: 'กรุงเทพมหานคร', types: ['locality'] },
      { longText: 'กรุงเทพมหานคร', shortText: 'กทม.', types: ['administrative_area_level_1'] },
      { longText: '10330', shortText: '10330', types: ['postal_code'] },
      { longText: 'ประเทศไทย', shortText: 'TH', types: ['country'] }
    ],
    postalAddress: { regionCode: 'TH', postalCode: '10330' },
    granularity: 'ROOFTOP',
    location: { latitude: 13.7563, longitude: 100.5018 },
    ...overrides
  }]
});

describe('Google residential enrichment', () => {
  it('accepts only a complete rooftop address aligned to the residential building', () => {
    expect(selectGoogleResidentialResult(response(), seed, 'TH')).toMatchObject({
      number: '99', postcode: '10330', property_type: 'apartment',
      residential_building_id: 'way/123', residential_evidence: 'OSM_BUILDING_GOOGLE=apartments:ROOFTOP'
    });
    expect(selectGoogleResidentialResult(response({ partialMatch: true }), seed, 'TH')).toBeNull();
    expect(selectGoogleResidentialResult(response({
      location: { latitude: 13.76, longitude: 100.51 }
    }), seed, 'TH')).toBeNull();
    expect(selectGoogleResidentialResult(response({
      postalAddress: { regionCode: 'TH' },
      addressComponents: response().results[0].addressComponents.filter(({ types }) => !types.includes('postal_code'))
    }), seed, 'TH')).toBeNull();
  });

  it('normalizes Arabic-Indic digits without weakening the Saudi postcode gate', () => {
    const saudi = response({
      placeId: 'google-saudi-1',
      addressComponents: [
        { longText: '١٢٣', types: ['street_number'] },
        { longText: 'شارع الملك فهد', types: ['route'] },
        { longText: 'العليا', types: ['sublocality_level_1'] },
        { longText: 'الرياض', types: ['locality'] },
        { longText: '١٢٣٤٥', types: ['postal_code'] },
        { longText: 'السعودية', shortText: 'SA', types: ['country'] }
      ],
      postalAddress: { regionCode: 'SA', postalCode: '١٢٣٤٥' }
    });
    expect(selectGoogleResidentialResult(saudi, seed, 'SA')).toMatchObject({
      number: '123', postcode: '12345'
    });

    const misleadingPostalAddress = {
      ...saudi,
      results: [{ ...saudi.results[0], postalAddress: { regionCode: 'SA', postalCode: 'ABCD EFGHI' } }]
    };
    expect(selectGoogleResidentialResult(misleadingPostalAddress, seed, 'SA')).toMatchObject({
      postcode: '12345'
    });
  });

  it('returns anonymous rejection reasons without retaining an upstream address', () => {
    const evaluation = evaluateGoogleResidentialResult(response({
      addressComponents: response().results[0].addressComponents
        .filter(({ types }) => !types.includes('postal_code')),
      postalAddress: { regionCode: 'TH' }
    }), seed, 'TH');
    expect(evaluation).toEqual({ record: null, reason: 'missing_postcode' });
  });

  it('maps Turkey administrative level four to the required district field', () => {
    const turkeySeed = {
      ...seed,
      latitude: 39.92,
      longitude: 32.85,
      ring: [[32.8499, 39.9199], [32.8501, 39.9199], [32.8501, 39.9201], [32.8499, 39.9201], [32.8499, 39.9199]]
    };
    const turkey = response({
      placeId: 'google-turkey-1',
      types: ['street_address', 'subpremise'],
      addressComponents: [
        { longText: '12', shortText: '12', types: ['street_number'] },
        { longText: 'Ataturk Caddesi', shortText: 'Ataturk Caddesi', types: ['route'] },
        { longText: 'Cankaya', shortText: 'Cankaya', types: ['administrative_area_level_4'] },
        { longText: 'Ankara', shortText: 'Ankara', types: ['administrative_area_level_2'] },
        { longText: 'Ankara', shortText: '06', types: ['administrative_area_level_1'] },
        { longText: '06690', shortText: '06690', types: ['postal_code'] },
        { longText: 'Turkiye', shortText: 'TR', types: ['country'] }
      ],
      postalAddress: { regionCode: 'TR', postalCode: '06690' },
      granularity: 'ROOFTOP',
      location: { latitude: turkeySeed.latitude, longitude: turkeySeed.longitude }
    });
    expect(selectGoogleResidentialResult(turkey, turkeySeed, 'TR')).toMatchObject({
      number: '12', street: 'Ataturk Caddesi', locality: 'Ankara', district: 'Cankaya', postcode: '06690'
    });
  });

  it('does not treat Turkey-specific administrative level four as a district elsewhere', () => {
    const nonTurkey = response({
      addressComponents: response().results[0].addressComponents
        .filter(({ types }) => !types.includes('sublocality_level_1'))
        .map((entry) => entry.types.includes('locality')
          ? { ...entry, longText: 'Example City', shortText: 'Example City' } : entry)
        .concat([{ longText: 'Example District', shortText: 'Example District', types: ['administrative_area_level_4'] }]),
      postalAddress: { regionCode: 'TH', postalCode: '10330' }
    });
    expect(selectGoogleResidentialResult(nonTurkey, seed, 'TH')).toBeNull();
  });

  it('supplements missing postal and administrative fields from the same reverse response', () => {
    const detailed = response().results[0];
    const incomplete = {
      ...detailed,
      addressComponents: detailed.addressComponents.filter(({ types }) =>
        !types.includes('sublocality_level_1') && !types.includes('postal_code')),
      postalAddress: { regionCode: 'TH' }
    };
    const postal = {
      placeId: 'google-postal-area-1',
      types: ['postal_code'],
      addressComponents: detailed.addressComponents.filter(({ types }) =>
        types.some((type) => ['sublocality_level_1', 'postal_code', 'country'].includes(type))),
      postalAddress: { regionCode: 'TH', postalCode: '10330' },
      granularity: 'APPROXIMATE',
      location: { latitude: 13.75, longitude: 100.5 }
    };
    expect(selectGoogleResidentialResult({ results: [incomplete, postal] }, seed, 'TH')).toMatchObject({
      number: '99', street: 'ถนนพระรามที่ 1', district: 'ปทุมวัน', postcode: '10330'
    });
  });

  it('rotates local credentials after an authorization failure', async () => {
    const credentials = [{ id: 'bad', secret: 'bad-key' }, { id: 'good', secret: 'good-key' }];
    const reports = [];
    const result = await requestGoogleReverse({
      latitude: seed.latitude,
      longitude: seed.longitude,
      language: 'th',
      credentialPool: {
        acquire: vi.fn(async (_provider, { excludeIds }) => credentials.find(({ id }) => !excludeIds.has(id)) || null),
        report: vi.fn(async (...args) => reports.push(args))
      },
      regionCode: 'TH',
      fetchImpl: vi.fn(async (_url, init) => init.headers['X-Goog-Api-Key'] === 'bad-key'
        ? new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 })
        : Response.json(response()))
    });
    expect(result.results).toHaveLength(1);
    expect(reports).toEqual([['bad', 'auth'], ['good', 'success']]);
  });

  it('waits for a short broker QPS window inside the same sync task', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
        code: 'SOURCE_RATE_LIMITED', retryAt: new Date(Date.now() + 10).toISOString()
      }))
      .mockResolvedValueOnce(response());
    await expect(requestGoogleReverse({
      latitude: seed.latitude,
      longitude: seed.longitude,
      language: 'th',
      regionCode: 'TH',
      brokerClient: { request }
    })).resolves.toMatchObject({ results: expect.any(Array) });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves long broker waits as resumable checkpoints', async () => {
    const error = Object.assign(new Error('rate limited'), {
      code: 'SOURCE_RATE_LIMITED', retryAt: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(requestGoogleReverse({
      latitude: seed.latitude,
      longitude: seed.longitude,
      language: 'th',
      regionCode: 'TH',
      brokerClient: { request: vi.fn().mockRejectedValue(error) }
    })).rejects.toBe(error);
  });

  it('builds the official v4 reverse request with header credentials and field masks', async () => {
    const definition = operationDefinitions['google-geocoding.reverse'];
    const requested = [];
    const result = await executeOperation({
      definition,
      parameters: definition.validate({ latitude: 20, longitude: 78, language: 'en', regionCode: 'IN' }),
      secret: 'google-secret',
      fetchImpl: vi.fn(async (request) => {
        requested.push(new URL(request.url));
        return Response.json({ results: [] });
      })
    });
    expect(result).toMatchObject({ type: 'success', status: 200, data: { results: [] } });
    expect(Object.fromEntries(requested[0].searchParams)).toEqual({
      'location.latitude': '20', 'location.longitude': '78', languageCode: 'en', regionCode: 'IN'
    });
    expect(requested[0].searchParams.has('types')).toBe(false);
    expect(requested[0].searchParams.has('granularity')).toBe(false);
    const request = definition.request(definition.validate({ latitude: 20, longitude: 78, language: 'en', regionCode: 'IN' }), 'google-secret');
    expect(request.url).not.toContain('google-secret');
    expect(request.headers.get('x-goog-api-key')).toBe('google-secret');
    expect(request.headers.get('x-goog-fieldmask')).toContain('results.postalAddress');
  });

  it('classifies Google HTTP throttling without inventing a monthly reset', async () => {
    const definition = operationDefinitions['google-geocoding.reverse'];
    const result = await executeOperation({
      definition,
      parameters: definition.validate({ latitude: 20, longitude: 78, language: 'en' }),
      secret: 'google-secret',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), {
        status: 429, headers: { 'retry-after': '2' }
      }))
    });
    expect(result).toMatchObject({ type: 'retry', outcome: 'qps', retryAt: expect.any(String) });
  });

  it('accepts the empty object returned by Google v4 for zero results', async () => {
    const definition = operationDefinitions['google-geocoding.reverse'];
    const result = await executeOperation({
      definition,
      parameters: definition.validate({ latitude: 12.58851755, longitude: 4.894037273, language: 'en', regionCode: 'NG' }),
      secret: 'google-secret',
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    });
    expect(result).toMatchObject({ type: 'success', status: 200, data: {} });
  });

  it('truncates output written after the last durable checkpoint', async () => {
    const directory = resolve('.data-cache', `google-progress-${process.pid}-${Date.now()}`);
    const output = resolve(directory, 'records.jsonl');
    await mkdir(directory, { recursive: true });
    await writeFile(output, [
      { source_record_id: 'seed-1:place-1' },
      { source_record_id: 'seed-2:place-2' }
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    try {
      await expect(reconcileGoogleProgressOutput(output, { nextIndex: 1, accepted: 1 })).resolves.toBe(true);
      expect((await readFile(output, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
