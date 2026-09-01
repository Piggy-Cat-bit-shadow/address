import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifest = JSON.parse(await readFile(resolve(root, 'config/lite-targets.json'), 'utf8'));
const seeds = JSON.parse(await readFile(resolve(root, 'config/lite-seeds.json'), 'utf8'));
const arg = (name, fallback = '') => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const out = resolve(arg('--out', resolve(root, '.lite-output')));
const metricsFile = resolve(arg('--metrics', resolve(out, 'metrics/native.json')));
const residential = new Set(['apartments','bungalow','cabin','detached','dormitory','ger','house','residential','semidetached_house','semi','terrace']);
const blocked = ['amenity','shop','office','tourism','industrial','craft','healthcare','military'];
const norm = value => String(value || '').normalize('NFKD').replace(/\p{M}+/gu, '').trim().toLocaleLowerCase('und');
const inside = (lon, lat, b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
const radii = { micro: [.010,.010], city: [.020,.015], region: [.035,.025] };

export const probeWindows = (target, pass = 1) => {
  const [dx, dy] = radii[target.scope] || radii.city;
  const factor = pass === 1 ? 1 : 2;
  return (seeds.targets[target.id] || []).slice(0, 4).map(([lon, lat]) => {
    const box = [Math.max(target.bounds[0], lon - dx * factor), Math.max(target.bounds[1], lat - dy * factor), Math.min(target.bounds[2], lon + dx * factor), Math.min(target.bounds[3], lat + dy * factor)];
    return box[0] < box[2] && box[1] < box[3] ? box : null;
  }).filter(Boolean);
};

export const overpassQuery = boxes => `[out:json][timeout:45];(${boxes.flatMap(([west,south,east,north]) => [
  `nwr[building~"^(apartments|bungalow|cabin|detached|dormitory|ger|house|residential|semidetached_house|semi|terrace)$"]["addr:housenumber"]["addr:street"](${south},${west},${north},${east});`,
  `nwr[building~"^(apartments|bungalow|cabin|detached|dormitory|ger|house|residential|semidetached_house|semi|terrace)$"]["addr:housenumber"]["addr:place"](${south},${west},${north},${east});`
]).join('')});out center tags;`;

export const filterAddresses = (elements, target) => elements.map(element => {
  const tags = element.tags || {};
  const point = element.center || (Number.isFinite(element.lat) && Number.isFinite(element.lon) ? { lat: element.lat, lon: element.lon } : null);
  const rawRegion = tags['addr:state'] || tags['addr:province'] || tags['addr:region'];
  if (!point || !residential.has(tags.building) || !tags['addr:housenumber'] || !(tags['addr:street'] || tags['addr:place']) || !inside(point.lon, point.lat, target.bounds)) return null;
  if (blocked.some(key => tags[key] && !['', 'no', 'none'].includes(norm(tags[key])))) return null;
  if (target.regionAliases?.length && rawRegion && !target.regionAliases.some(alias => norm(alias) === norm(rawRegion))) return null;
  const street = tags['addr:street'] || tags['addr:place'];
  const city = tags['addr:city'] || tags['addr:town'] || tags.municipality || tags['addr:village'] || tags['addr:suburb'] || target.label;
  const region = rawRegion || target.label;
  const postcode = tags['addr:postcode'] || '';
  const id = `osm:${element.type}:${element.id}`;
  return { id, region, regionCode: tags['addr:state_code'] || '', city, locality: city, postalLocality: city, district: tags['addr:district'] || tags['addr:county'] || tags['addr:suburb'] || '', postcode, street, houseNumber: tags['addr:housenumber'], buildingName: tags.name || '', unit: tags['addr:unit'] || tags['addr:flats'] || '', latitude: point.lat, longitude: point.lon, propertyType: tags.building === 'apartments' ? 'apartment' : 'residential', residentialEvidence: true, qualityScore: 100 + (postcode ? 20 : 0) + (city ? 10 : 0) + (rawRegion ? 5 : 0) + (tags.building === 'apartments' ? 2 : 0), formattedAddress: [tags['addr:housenumber'], street, city, region, postcode, tags['addr:country']].filter(Boolean).join(', '), formattedAddressEn: '', formattedAddressZh: '', source: { name: 'OpenStreetMap', url: `https://www.openstreetmap.org/${element.type}/${element.id}`, license: 'ODbL 1.0', licenseUrl: 'https://opendatacommons.org/licenses/odbl-1-0/', attribution: '© OpenStreetMap contributors', attributionUrl: 'https://www.openstreetmap.org/copyright', datasetVersion: `overpass:${new Date().toISOString().slice(0,10)}`, sourceRecordId: `${element.type}/${element.id}` } };
}).filter(Boolean);

let requests = 0; let retries = 0; let fallbackRequests = 0; let elementsReceived = 0;
const fetchOverpass = async query => {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) { retries += 1; await new Promise(resolveDelay => setTimeout(resolveDelay, attempt === 1 ? 1000 : 2000)); }
    const endpoint = attempt < 2 ? 'https://overpass-api.de/api/interpreter' : 'https://overpass.kumi.systems/api/interpreter';
    requests += 1; if (attempt === 2) fallbackRequests += 1;
    try { const response = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(50_000) });
      if (response.ok) { const data = await response.json(); elementsReceived += data.elements?.length || 0; return data.elements || []; }
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(`Overpass HTTP ${response.status}`);
      last = new Error(`Overpass HTTP ${response.status}`);
    } catch (error) { last = error; }
  }
  throw last;
};
const hierarchy = (target, addresses) => {
  const groups = new Map();
  for (const address of addresses) { const key = [address.region, address.city, address.postcode || '*'].map(norm).join('|'); const bucket = groups.get(key) || []; if (bucket.length < 3) bucket.push(address); groups.set(key, bucket); }
  const selected = [...groups.values()].flat().sort((a,b) => b.qualityScore - a.qualityScore || a.id.localeCompare(b.id)).slice(0, manifest.candidateProfiles[target.scope].outputCap);
  const regions = [...new Map(selected.map(a => [a.region, { name: a.region, cities: [] }])).values()];
  for (const region of regions) { const cities = [...new Map(selected.filter(a => a.region === region.name).map(a => [a.city, { name: a.city, postcodes: [] }])).values()]; for (const city of cities) city.postcodes = [...new Map(selected.filter(a => a.region === region.name && a.city === city.name).map(a => [a.postcode || '', { postcode: a.postcode || '', addresses: selected.filter(x => x.region === region.name && x.city === city.name && (x.postcode || '') === (a.postcode || '')) }])).values()]; region.cities = cities; }
  return { selected, regions };
};
const startedAt = new Date().toISOString(); const failedCountries = []; let emptyTargets = 0; let acceptedAddresses = 0;
await mkdir(out, { recursive: true });
for (const country of [...new Set(manifest.targets.map(target => target.country))]) {
  const targets = manifest.targets.filter(target => target.country === country); const found = new Map(targets.map(target => [target.id, []])); const probeCounts = new Map(targets.map(target => [target.id, 0]));
  try { for (const pass of [1, 2]) { const pending = targets.filter(target => found.get(target.id).length < 3); const boxes = pending.flatMap(target => { const values = probeWindows(target, pass); probeCounts.set(target.id, probeCounts.get(target.id) + values.length); return values; }); if (!boxes.length) break; const elements = await fetchOverpass(overpassQuery(boxes)); for (const target of pending) { const map = new Map(found.get(target.id).map(address => [[country, address.postcode || address.city, address.street, address.houseNumber].map(norm).join('|'), address])); for (const address of filterAddresses(elements, target)) { const key = [country, address.postcode || address.city, address.street, address.houseNumber].map(norm).join('|'); if (!map.has(key) || map.get(key).qualityScore < address.qualityScore) map.set(key, address); } found.set(target.id, [...map.values()]); } await new Promise(resolveDelay => setTimeout(resolveDelay, 500)); }
    for (const target of targets) { const { selected, regions } = hierarchy(target, found.get(target.id)); if (!selected.length) emptyTargets += 1; acceptedAddresses += selected.length; const cap = manifest.candidateProfiles[target.scope].outputCap; const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), country, target: { id: target.id, label: target.label, labelZh: target.labelZh, category: target.category, scope: target.scope, bounds: target.bounds, note: target.note || '', ...(target.tax ? { tax: target.tax } : {}) }, stats: { addresses: selected.length, regions: regions.length, cities: regions.reduce((sum, region) => sum + region.cities.length, 0), postcodes: regions.reduce((sum, region) => sum + region.cities.reduce((sum2, city) => sum2 + city.postcodes.length, 0), 0), maxAddressesPerPostcode: 3, maxAddressesPerTarget: cap, probeRequests: probeCounts.get(target.id), elementsReceived: 0, accepted: selected.length, rejected: 0, pass: true }, regions }; await mkdir(dirname(resolve(out, target.file)), { recursive: true }); await writeFile(resolve(out, target.file), `${JSON.stringify(result)}\n`); }
  } catch (error) { failedCountries.push({ country, error: String(error) }); }
}
const metrics = { startedAt, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(startedAt), countries: new Set(manifest.targets.map(target => target.country)).size, targets: manifest.targets.length, requests, retries, fallbackRequests, elementsReceived, acceptedAddresses, emptyTargets, failedCountries };
await mkdir(dirname(metricsFile), { recursive: true }); await writeFile(metricsFile, `${JSON.stringify(metrics, null, 2)}\n`);
if (failedCountries.length) throw new AggregateError(failedCountries.map(item => new Error(`${item.country}: ${item.error}`)), 'Lite native refresh failed');
