import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import App, {
  createRequestId,
  fetchWithTimeout,
  generationErrorMessageKey,
  generatorTitle,
  IP_GENERATION_REQUEST_TIMEOUT_MS,
  LOCATION_OPTION_RENDER_LIMIT,
  selectAvailableCountry
} from '../src/components/App';
import { resolveAmapServiceHost } from '../src/components/AmapPreview';
import { countries } from '../src/domain/countries';
import { messages } from '../src/domain/i18n';

const appSource = App.toString();
const amapSource = readFileSync('src/components/AmapPreview.tsx', 'utf8');
const adminPageSource = readFileSync('src/pages/admin.astro', 'utf8');
const adminSource = readFileSync('src/components/SyncAdmin.tsx', 'utf8');
const adminStyles = readFileSync('src/styles/admin.css', 'utf8');
const worldMapSource = readFileSync('src/components/WorldCoverageMap.tsx', 'utf8');
const monitorSource = readFileSync('src/components/PublicMonitor.tsx', 'utf8');

describe('strict residential generator page structure', () => {
  it('keeps the standalone admin page branded and exposes blacklist management', () => {
    expect(adminPageSource).toContain('href="/favicon.svg"');
    expect(adminSource).toContain("blacklist: '地址黑名单'");
    expect(adminSource).toContain("blacklistTitle: '地址黑名单'");
    expect(adminSource).toContain("'/settings/blacklist'");
    expect(adminSource).not.toContain('admin-topbar-copy');
    expect(adminSource).toContain('合格住宅小区');
    expect(adminSource).toContain("onemap: 'OneMap'");
    expect(adminSource).toContain("amap: '高德地图'");
    expect(adminSource).toContain("baidu: '百度地图'");
    expect(adminSource).toContain("tencent: '腾讯地图'");
    expect(adminSource).toContain("provider: 'API 名称'");
    expect(adminSource).toContain("amapBrowserTitle: '高德前端地图凭据'");
    expect(adminSource).not.toContain("request('/settings/youdao'");
    expect(adminSource).toContain('YoudaoCredentialDialog');
    expect(adminSource).toContain('provider-key-secrets');
    expect(adminStyles).toContain('grid-template-columns: minmax(135px, .8fr) minmax(210px, 1.15fr) minmax(105px, .65fr) minmax(190px, 1.1fr) 146px');
    expect(adminSource).toContain('dashboard-kpis');
    expect(worldMapSource).toContain('world-distribution-map');
    expect(worldMapSource).toContain('map-zoom-controls');
    expect(adminSource).toContain('CountryCoverageTable');
    expect(adminSource).toContain('https://flagcdn.com/24x18/');
    expect(adminSource).toContain('country-flag');
    expect(adminSource).toContain('map-dialog-backdrop');
    expect(worldMapSource).toContain('cooperativeGestures: true');
    expect(worldMapSource).toContain('renderWorldCopies: false');
    expect(worldMapSource).toContain('setMaxBounds(worldBounds)');
    expect(worldMapSource).toContain('[[-179.999999, -85], [179.999999, 85]]');
    expect(worldMapSource).toContain("sourceUrl = '/maps/world-map-units.geojson'");
    expect(worldMapSource).toContain("admin1Url = (code: string) => `/maps/admin-1/${code}.geojson`");
    expect(worldMapSource).toContain("id: `admin-1-border-${normalized}`");
    expect(worldMapSource).toContain("id: `admin-1-fill-${normalized}`");
    expect(worldMapSource).toContain("id: `admin-1-label-${normalized}`");
    expect(worldMapSource).toContain("promoteId: 'region_code'");
    expect(worldMapSource).toContain("import('maplibre-gl')");
    expect(worldMapSource).not.toContain("import maplibregl from 'maplibre-gl'");
    expect(worldMapSource).toContain('onBack');
    expect(worldMapSource).toContain("map.getZoom() < 2.8");
    expect(worldMapSource).toContain("id: 'country-labels'");
    expect(worldMapSource).not.toContain('<svg');
    expect(adminSource).toContain('continentFilter');
    expect(adminSource).toContain('sortResidentialDesc');
    expect(adminSource).toContain('item.countryCode.toUpperCase()');
    expect(adminSource).not.toContain('map-country-flag');
    expect(adminSource).toContain('const visible = root ? filtered');
    expect(adminSource).not.toContain('dashboard-ranking');
    expect(adminSource).not.toContain('const exportRows');
    expect(adminSource).not.toContain('dashboardSearch');
    expect(adminSource).toContain('country-data-table');
    expect(adminSource).toContain('admin-sidebar-status');
    expect(adminSource).toContain('node.level === 0 ? [node] : [...trail, node]');
    expect(adminSource).toContain('loadControllers.current[selected]?.abort()');
    expect(adminSource).toContain("!authenticated || view !== 'addressData' || !addressDataRunning");
    expect(adminStyles).toContain('.nav-icon');
    expect(adminStyles).toContain('.dashboard-loading');
    expect(adminStyles).toContain('.dashboard-map-row');
    expect(adminStyles).toContain('.country-coverage-table');
    expect(adminStyles).toContain('.map-zoom-controls');
    expect(adminStyles).toContain('.coverage-map-popup');
    expect(adminStyles).toContain('.map-dialog');
    expect(adminSource).not.toContain("policies: '同步策略'");
    expect(adminSource).not.toContain("runs: '任务中心'");
    expect(adminSource).not.toContain("ordinary: '普通地址'");
    expect(adminSource).toContain('/china/areas?');
  });
  it('resolves the AMap proxy to an absolute same-origin service host', () => {
    expect(resolveAmapServiceHost('/_AMapService', 'https://address.example')).toBe('https://address.example/_AMapService');
    expect(resolveAmapServiceHost('/_AMapService/', 'http://localhost:4321')).toBe('http://localhost:4321/_AMapService');
    expect(() => resolveAmapServiceHost('https://other.example/_AMapService', 'https://address.example')).toThrow('INVALID_AMAP_SERVICE_HOST');
    expect(() => resolveAmapServiceHost('/_AMapService', 'http://address.example')).toThrow('INVALID_AMAP_SERVICE_HOST');
    expect(() => resolveAmapServiceHost('/other', 'https://address.example')).toThrow('INVALID_AMAP_SERVICE_HOST');
  });

  it('defaults to the United States and exposes 27 countries in nine ordered groups', () => {
    expect(countries[0].code).toBe('US');
    expect(new Set(countries.map((country) => country.group)).size).toBe(9);
    expect(countries).toHaveLength(27);
    expect(appSource).toContain('useState)("US")');
    expect(appSource).toContain('country-browser');
    expect(appSource).toContain('selectAvailableCountry');
    expect(appSource).not.toContain('ipCountry');
    expect(appSource).not.toContain('sessionCountry');
    expect(selectAvailableCountry(undefined, new Set(['JP', 'US']))).toBe('US');
    expect(selectAvailableCountry('JP', new Set(['JP', 'US']))).toBe('JP');
    expect(selectAvailableCountry('CN', new Set(['JP']))).toBe('JP');
  });

  it('uses the lightweight availability endpoint without rendering a public statistics strip', () => {
    expect(appSource).toContain('/v1/availability');
    expect(appSource).not.toContain('/v1/countries');
    expect(appSource).not.toContain('availability-monitor');
    expect(appSource.indexOf('resetFor(requestedCountry')).toBeLessThan(appSource.indexOf('loadResidentialCountries()'));
  });

  it('uses a concise residential heading and a safe address-language menu', () => {
    expect(messages['zh-CN'].residentialMode).toBe('真实住宅地址');
    expect(generatorTitle('英国', 'zh-CN', messages['zh-CN'].residentialMode)).toBe('英国真实住宅地址');
    expect(generatorTitle('United Kingdom', 'en', messages.en.residentialMode)).toBe('United Kingdom Residential address');
    expect(appSource).not.toContain('mode-tabs');
    expect(appSource).toContain('useState)("residential")');
    expect(appSource).not.toContain('residential-toggle');
    expect(appSource).toContain('AddressLanguageControl');
    expect(appSource).not.toContain('selectedCountryName} · {t.title');
    expect(appSource).toContain('googleMaps.embedUrl');
  });

  it('keeps profile labels in the interface locale while localizing profile values', () => {
    expect(appSource).toMatch(/label:\s*t\.fullName/u);
    expect(appSource).toMatch(/value:\s*displayedFullName/u);
    expect(appSource).toMatch(/value:\s*profileValueText\[result\.profile\.gender\]/u);
    expect(appSource).toMatch(/copyLabel:\s*t\.copy/u);
    expect(appSource).not.toMatch(/label:\s*profileText\.fullName/u);
  });

  it('links the top navigation GitHub icon to the public repository', () => {
    expect(appSource).toContain('https://github.com/daimon3332/address');
    expect(appSource).toContain('github-link');
    expect(appSource).toMatch(/"aria-label"\s*:\s*"GitHub"/);
    expect(appSource).toContain('noopener noreferrer');
    expect(appSource).toContain('_blank');
  });

  it('links the generator to the localized public data monitor', () => {
    expect(appSource).toContain('monitor-link');
    expect(appSource).toContain('/monitor/');
    expect(monitorSource).toContain('/web-api/v1/public-monitor');
    expect(monitorSource).toContain('WorldCoverageMap');
    expect(monitorSource.match(/<WorldCoverageMap/gu)).toHaveLength(1);
    expect(monitorSource).toContain('createPortal');
    expect(monitorSource).toContain('MapSlot');
    expect(monitorSource).toContain('onBack={() => backTo(-1)}');
  });

  it('renders structured address, profile, simple card and map groups', () => {
    expect(appSource).toContain('address-table');
    expect(appSource).toContain('profile-card');
    expect(appSource).toContain('card-section');
    expect(appSource).toContain('map-frame');
    expect(appSource).toContain('extension-grid');
    expect(appSource).not.toContain('test-card');
    expect(countries.find(({ code }) => code === 'HK')?.name['zh-CN']).toBe('香港');
    expect(countries.find(({ code }) => code === 'TW')?.name['zh-CN']).toBe('台湾');
  });

  it('loads only administrator-enabled map renderers and keeps server secrets out of frontend code', () => {
    expect(appSource).toContain('/v1/config/maps?country=');
    expect(appSource).toContain('googleMapEnabled &&');
    expect(appSource).toContain('amapMapEnabled &&');
    expect(appSource).toContain('mapPreviewEnabled &&');
    expect(amapSource).toContain("countryCode === 'CN'");
    expect(amapSource).toContain("serviceHost");
    expect(amapSource).not.toContain('AMAP_JS_SECURITY_CODE');
    expect(amapSource).not.toContain('AMAP_API_KEY');
    expect(amapSource).not.toContain('securityCode');
  });

  it('uses searchable filter inputs and working sidebar shortcuts', () => {
    expect(appSource).toContain('Combobox');
    expect(appSource).toContain('loadOptions');
    expect(appSource).not.toContain('datalist');
    expect(appSource).toContain('void generate(overrides)');
    expect(appSource).toContain('params.set("regionId"');
    expect(appSource).toContain('params.set("cityId"');
    expect(appSource).toContain('params.set("postcodeId"');
    expect(appSource).toContain('option.regionValue');
    expect(appSource).toContain('/v1/config/country-shortcuts');
    expect(appSource).toContain('selectedShortcuts.specialAreas');
    expect(appSource.indexOf('selectedShortcuts.specialAreas')).toBeLessThan(appSource.indexOf('selectedShortcuts.adminShortcuts'));
    expect(appSource.indexOf('selectedShortcuts.adminShortcuts')).toBeLessThan(appSource.indexOf('selectedShortcuts.popularCities'));
    expect(appSource).not.toContain('selectedCountry.popularCities.filter');
    expect(appSource).not.toContain('items.slice(0, 10)');
  });

  it('uses the custom admin locale menu and a compact administrator identity', () => {
    expect(adminSource).toContain('function LocaleMenu');
    expect(adminSource).toContain('role="listbox"');
    expect(adminSource).not.toContain('const LocaleSelect');
    expect(adminSource).not.toContain('<small>{t.administratorRole}</small>');
    expect(adminSource).toContain('<strong>{t.administrator}</strong>');
    expect(adminSource).toContain("shortcuts: '/settings/country-shortcuts'");
  });

  it('edits localized country shortcuts through counted catalog dropdowns', () => {
    expect(adminSource).toContain("value.countryCode === 'US'");
    expect(adminSource).toContain('/settings/country-shortcuts/${countryCode}/options?${params}');
    expect(adminSource).toContain('option.availableCount.toLocaleString(locale)');
    expect(adminSource).toContain("label: { en: option.en || option.value, 'zh-CN': option.zhCN");
    expect(adminSource).toContain("await mutate(`/settings/country-shortcuts/${value.countryCode}`, 'PUT', draft");
    expect(adminSource).toContain('shortcutLabel(item, locale)');
    expect(adminSource).not.toContain('item.label.en}</strong><small>{item.label');
  });

  it('paginates and searches large city catalogs on the server', () => {
    expect(appSource).toContain('field === "postcode" ? "100" : "200"');
    expect(appSource).toContain('if (query.trim())');
    expect(appSource).toContain('onLoadMore: () => loadOptions("city"');
    expect(LOCATION_OPTION_RENDER_LIMIT).toBe(200);
  });

  it('guards JSON responses and stale generation contexts', () => {
    expect(appSource).toContain('content-type');
    expect(appSource).toContain('API response is not JSON');
    expect(appSource).toContain('activeRequest');
    expect(appSource).toContain('requestId');
    expect(appSource).toContain('locationControllers.current[field] !== controller');
  });

  it('creates request IDs without requiring crypto.randomUUID', () => {
    const fallback = createRequestId({
      getRandomValues: (bytes) => {
        bytes.fill(0xab);
        return bytes;
      }
    });
    expect(fallback).toBe('abababab-abab-4bab-abab-abababababab');
    expect(createRequestId({ randomUUID: () => 'native-id' })).toBe('native-id');
  });

  it('aborts stalled frontend requests with a visible timeout code', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const request = fetchWithTimeout('/api/v1/generate', {}, 25, fetchImpl);
    const rejection = expect(request).rejects.toThrow('REQUEST_TIMEOUT');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    vi.useRealTimers();
  });

  it('maps generation error codes to specific messages', () => {
    expect(generationErrorMessageKey('NO_POOL_COVERAGE', false)).toBe('noPoolCoverage');
    expect(generationErrorMessageKey('IP_REGION_NO_RESULT', true)).toBe('ipNoResult');
    expect(generationErrorMessageKey('UPSTREAM_TIMEOUT', false)).toBe('retry');
    expect(generationErrorMessageKey('NO_SOURCE_RESULT', false)).toBe('requestFailed');
    expect(generationErrorMessageKey('IP_DATABASE_UNAVAILABLE', true)).toBe('ipLookupFailed');
    expect(messages['zh-CN'].noPoolCoverage).toBe('当前筛选暂无已同步地址，请更换筛选或等待下次同步。');
  });

  it('renders IP-region controls and submits the dedicated generation mode', () => {
    expect(appSource).toContain('ip-region-panel');
    expect(appSource).toContain('/v1/client-context');
    expect(appSource).toContain('params.set("mode", "ip-region")');
    expect(appSource).toContain('ipMatchLevel');
    expect(appSource).toContain('ip-region-result');
    expect(messages.en.generateNearIp).toBeTruthy();
    expect(messages['zh-CN'].generateNearIp).toBeTruthy();
    expect(messages.en.publicIp).toBeTruthy();
    expect(messages['zh-CN'].publicIp).toBeTruthy();
    expect(IP_GENERATION_REQUEST_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it('copies the detected public IP into the manual field without generating', () => {
    expect(appSource).toContain('useCurrentIp');
    expect(appSource).toContain('setManualIp(detected.publicIp || "")');
    expect(appSource).toContain('ip: requestedIp');
    expect(appSource).not.toContain('cdn-cgi/trace');
    expect(appSource).not.toContain('setManualIp("");void generate({ipRegion:true,ip:"",strategy:"instant"})');
  });

  it('prefetches database-backed results for every country and retains scoped queues', () => {
    expect(appSource).toContain('prefetchedResults');
    expect(appSource).toContain('paramsFor(spec, requestId, "instant")');
    expect(appSource).toContain('prefetchCountry(country.code)');
    expect(appSource).toContain('onMouseEnter');
    expect(appSource).toContain('onFocus');
    expect(appSource).toContain('prefetchedResults.current.set(key');
    expect(appSource).not.toContain('prefetchedResults.current.clear()');
    expect(appSource).not.toContain('sourcesTried?.includes("address-pool-v2")');
  });

  it('keeps residential mode implicit and exposes no live-provider control', () => {
    expect(appSource).toContain('url.searchParams.delete("mode")');
    expect(appSource).not.toContain('url.searchParams.set("mode", nextMode)');
    expect(appSource).not.toContain('live-api-toggle');
    expect(appSource).not.toContain('live: String(spec.live)');
  });

  it('renders coherent profile, network and sandbox-card fields', () => {
    expect(appSource).toContain('extensions.basic.bmi');
    expect(appSource).toContain('extensions.internet.os');
    expect(appSource).toContain('extensions.internet.securityQuestion');
    expect(appSource).toContain('extensions.internet.securityAnswer');
    expect(appSource).toContain('extensions.internet.ipAddress');
    expect(appSource).toContain('extensions.internet.macAddress');
    expect(appSource).toContain('result.card.network');
    expect(appSource).toContain('result.card.number');
    expect(appSource).toContain('result.card.cvc');
    const profileStart = appSource.indexOf('profile-card');
    const phone = appSource.indexOf('id: "phone"');
    const addressFormat = appSource.indexOf('address-format-grid');
    expect(phone).toBeGreaterThan(profileStart);
    expect(phone).toBeGreaterThan(addressFormat);
  });

  it('hides employment and income details for non-working statuses', () => {
    expect(appSource).toContain('hasEmploymentDetails(extensions.employment)');
    expect(appSource).toContain('extensions.finance.incomeRange &&');
  });

  it('renders filters and result rows from each country address schema', () => {
    expect(appSource).toContain('selectedCountry.addressSchema');
    expect(appSource).toContain('addressSchema.filters');
    expect(appSource).toContain('addressSchema.resultFields');
    expect(appSource).toContain('filterFields.includes("region")');
    expect(appSource).toContain('filterFields.includes("city")');
    expect(appSource).toContain('filterFields.includes("postcode")');
    const unitedStates = countries.find(({ code }) => code === 'US')!;
    expect(unitedStates.addressSchema.filters).toEqual(['region', 'city']);
    expect(unitedStates.addressSchema.resultFields.map(({ field }) => field)).toContain('postcode');
    const china = countries.find(({ code }) => code === 'CN')!;
    expect(china.addressSchema.filters).toEqual(['region', 'city', 'district']);
    expect(china.searchLabels.district?.['zh-CN']).toBe('区县');
    const hongKong = countries.find(({ code }) => code === 'HK')!;
    expect(hongKong.addressSchema.filters).toEqual(['region', 'city']);
  });

  it('provides visible and accessible copy feedback with a DOM fallback', () => {
    expect(appSource).toContain('copy-toast');
    expect(appSource).toContain('aria-live');
    expect(appSource).toContain('aria-atomic');
    expect(appSource).toContain('document.execCommand("copy")');
    expect(appSource).toContain('navigator.clipboard');
    expect(messages.en.copySuccess).toBeTruthy();
    expect(messages.en.copyFailed).toBeTruthy();
    expect(messages['zh-CN'].copySuccess).toBeTruthy();
    expect(messages['zh-CN'].copyFailed).toBeTruthy();
  });
});
