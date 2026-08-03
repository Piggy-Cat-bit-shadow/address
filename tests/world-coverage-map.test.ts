import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { shortestLongitudeInterval } from '../src/components/WorldCoverageMap';

const visitLongitudes = (value: unknown, longitudes: number[]): void => {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    longitudes.push(value[0]);
    return;
  }
  value.forEach((entry) => visitLongitudes(entry, longitudes));
};

describe('world coverage map bounds', () => {
  it('uses the shortest interval for a country crossing the antimeridian', () => {
    expect(shortestLongitudeInterval([19, 180, -179, -169])).toEqual([19, 191]);
  });

  it('preserves ordinary western hemisphere bounds', () => {
    expect(shortestLongitudeInterval([-171, -66, -120])).toEqual([-171, -66]);
  });

  it('does not fit the bundled Russia geometry as a whole-world feature', () => {
    const collection = JSON.parse(readFileSync('public/maps/world-map-units.geojson', 'utf8'));
    const feature = collection.features.find((entry: { properties: Record<string, string> }) => entry.properties.ISO_A2 === 'RU');
    const longitudes: number[] = [];
    visitLongitudes(feature.geometry.coordinates, longitudes);
    const interval = shortestLongitudeInterval(longitudes);

    expect(interval).toBeDefined();
    expect(interval![1] - interval![0]).toBeLessThan(200);
  });

  it('ignores invalid and empty coordinates', () => {
    expect(shortestLongitudeInterval([Number.NaN, Number.POSITIVE_INFINITY])).toBeUndefined();
  });

  it('ships non-empty lazy Admin-1 boundaries for every supported country', () => {
    const files = readdirSync('public/maps/admin-1').filter((file) => file.endsWith('.geojson')).sort();
    expect(files).toHaveLength(27);
    for (const file of files) {
      const code = file.slice(0, 2);
      const collection = JSON.parse(readFileSync(`public/maps/admin-1/${file}`, 'utf8'));
      expect(collection.type).toBe('FeatureCollection');
      expect(collection.features.length).toBeGreaterThan(0);
      expect(collection.features.every((feature: { properties: Record<string, string> }) =>
        feature.properties.country_code === code)).toBe(true);
    }
  });
});
