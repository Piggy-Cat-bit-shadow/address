import { useEffect, useMemo, useState } from 'react';
import './LiteApp.css';

type Locale = 'en' | 'zh-CN';
type Category = 'low_tax' | 'major_city';
type TaxType = 'tax_free' | 'low_tax' | 'special_tax_zone' | 'vat_gst_reduced' | 'customs_free_zone';
interface TaxMetadata { type: TaxType; rate: string; label: string; note: string; noteZh: string }
interface TargetIndex { id: string; label: string; labelZh: string; category: Category; scope: string; file: string; note: string; tax?: TaxMetadata; maxAddresses: number; addresses: number; postcodes: number }
interface CountryIndex { code: string; name: string; nameZh: string; targets: TargetIndex[] }
interface IndexPayload { generatedAt: string; maxAddressesPerPostcode: number; totalAddresses: number; countries: CountryIndex[] }
interface AddressSource { name: string; url: string; license: string; licenseUrl: string; attribution: string; attributionUrl: string; datasetVersion: string; sourceRecordId: string }
interface AddressItem {
  id: string; region: string; regionCode: string; city: string; locality: string; postalLocality: string; district: string;
  postcode: string; street: string; houseNumber: string; buildingName: string; unit: string; latitude: number; longitude: number;
  propertyType: 'residential' | 'apartment'; residentialEvidence: boolean; qualityScore: number; formattedAddress: string; formattedAddressEn: string; formattedAddressZh: string; source: AddressSource;
}
interface PostcodeNode { postcode: string; addresses: AddressItem[] }
interface CityNode { name: string; postcodes: PostcodeNode[] }
interface RegionNode { name: string; cities: CityNode[] }
interface TargetPayload { generatedAt: string; target: { id: string; label: string; labelZh: string; category: Category; note: string; tax?: TaxMetadata }; stats: { addresses: number; postcodes: number }; regions: RegionNode[] }

export const taxTypeLabels: Record<Locale, Record<TaxType, string>> = {
  en: {
    tax_free: 'Tax-free state / territory',
    low_tax: 'Low-tax state / province',
    special_tax_zone: 'Special tax zone',
    vat_gst_reduced: 'VAT / GST reduced area',
    customs_free_zone: 'Customs-free zone'
  },
  'zh-CN': {
    tax_free: '免税州 / 地区',
    low_tax: '低税州 / 省',
    special_tax_zone: '特殊税区',
    vat_gst_reduced: 'VAT / GST 优惠区',
    customs_free_zone: '免税海关区'
  }
};

export const formatTaxReference = (tax: TaxMetadata, locale: Locale) => {
  const reference = `${tax.rate} ${tax.label}`;
  const note = locale === 'zh-CN' ? tax.noteZh : tax.note;
  return note ? `${reference} · ${note}` : reference;
};

type StructuredAddressFields = Pick<AddressItem, 'houseNumber' | 'street' | 'city' | 'locality' | 'postalLocality' | 'region' | 'regionCode' | 'postcode'>;

export const formatLiteAddressLines = (address: StructuredAddressFields, countryName: string) => {
  const clean = (value?: string) => value?.trim() || '';
  const streetLine = [clean(address.houseNumber), clean(address.street)].filter(Boolean).join(' ');
  const locality = [address.city, address.locality, address.postalLocality].map(clean).find(Boolean) || '';
  const region = clean(address.regionCode) || clean(address.region);
  const localityRegion = [...new Set([locality, region].filter(Boolean))].join(', ');
  const locationLine = [localityRegion, clean(address.postcode)].filter(Boolean).join(' ');
  const lines = [streetLine, locationLine, clean(countryName)].filter(Boolean);
  return { streetLine, locationLine, countryLine: clean(countryName), lines, copyText: lines.join('\n') };
};

const copyText = async (value: string) => navigator.clipboard?.writeText(value);
const randomItem = <T,>(values: T[]): T | undefined => {
  if (!values.length) return undefined;
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint32Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return values[bytes[0] % values.length];
  }
  return values[Math.floor(Math.random() * values.length)];
};
const strings = {
  en: {
    title: 'Address Lite', subtitle: 'Verified residential addresses · static data · no server API', mobileSubtitle: 'Verified residential address lookup', country: 'Country / region', category: 'Address group',
    low: 'Low-tax / tax-free', cities: 'Major cities', target: 'Target area', region: 'Region', city: 'City / locality', postcode: 'Postcode',
    any: 'Any', generate: 'Generate address', another: 'Another one', copy: 'Copy', copied: 'Copied', verified: 'Residential evidence verified',
    noData: 'No verified residential address is available for this selection.', loading: 'Loading static address data…', source: 'Source', updated: 'Data build',
    addresses: 'addresses', mobileAddresses: 'residential addresses', mobileCountries: 'countries / regions', postcodes: 'postcode groups', taxType: 'Tax type', taxReference: 'Tax reference', location: 'Coordinates', unavailable: 'This group is not configured for the selected country.'
  },
  'zh-CN': {
    title: 'Address Lite', subtitle: '真实住宅证据验证 · 全静态数据 · 不需要服务器 API', mobileSubtitle: '真实住宅地址查询', country: '国家 / 地区', category: '地址分类',
    low: '低税 / 免税地区', cities: '主要城市', target: '目标地区', region: '州 / 地区', city: '城市 / 地区', postcode: '邮政编码',
    any: '任意', generate: '随机生成地址', another: '换一个', copy: '复制', copied: '已复制', verified: '已通过住宅证据验证',
    noData: '当前筛选条件没有可用的已验证住宅地址。', loading: '正在加载静态地址数据…', source: '数据来源', updated: '数据构建时间',
    addresses: '条地址', mobileAddresses: '条住宅地址', mobileCountries: '个国家 / 地区', postcodes: '个邮编组', taxType: '低税类型', taxReference: '税率参考', location: '坐标', unavailable: '当前国家没有配置这一分类。'
  }
} as const;

export default function LiteApp({ locale }: { locale: Locale }) {
  const t = strings[locale];
  const [index, setIndex] = useState<IndexPayload>();
  const [countryCode, setCountryCode] = useState('US');
  const [category, setCategory] = useState<Category>('low_tax');
  const [targetId, setTargetId] = useState('');
  const [payload, setPayload] = useState<TargetPayload>();
  const [regionName, setRegionName] = useState('');
  const [cityName, setCityName] = useState('');
  const [postcode, setPostcode] = useState('');
  const [result, setResult] = useState<AddressItem>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/data/countries.json', { cache: 'no-cache' })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
      .then((data: IndexPayload) => {
        setIndex(data);
        const initial = data.countries.some((country) => country.code === 'US') ? 'US' : data.countries[0]?.code || '';
        setCountryCode(initial);
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  const country = useMemo(() => index?.countries.find((entry) => entry.code === countryCode), [index, countryCode]);
  const availableCategories = useMemo(() => new Set(country?.targets.map((target) => target.category) || []), [country]);
  const targets = useMemo(() => country?.targets.filter((target) => target.category === category) || [], [country, category]);
  const target = useMemo(() => country?.targets.find((entry) => entry.id === targetId), [country, targetId]);

  useEffect(() => {
    if (!country) return;
    const nextCategory: Category = availableCategories.has(category) ? category : availableCategories.has('low_tax') ? 'low_tax' : 'major_city';
    if (nextCategory !== category) setCategory(nextCategory);
  }, [country, availableCategories, category]);

  useEffect(() => {
    const next = targets[0]?.id || '';
    if (!targets.some((entry) => entry.id === targetId)) setTargetId(next);
  }, [targets, targetId]);

  useEffect(() => {
    setPayload(undefined); setResult(undefined); setRegionName(''); setCityName(''); setPostcode(''); setError('');
    if (!target) return;
    setLoading(true);
    fetch(target.file, { cache: 'no-cache' })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
      .then((data: TargetPayload) => {
        setPayload(data);
        setRegionName(data.regions[0]?.name || '');
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, [target?.id]);

  const region = useMemo(() => payload?.regions.find((entry) => entry.name === regionName), [payload, regionName]);
  useEffect(() => {
    if (!region) { setCityName(''); return; }
    if (!region.cities.some((entry) => entry.name === cityName)) setCityName(region.cities[0]?.name || '');
  }, [region, cityName]);
  const city = useMemo(() => region?.cities.find((entry) => entry.name === cityName), [region, cityName]);
  useEffect(() => {
    if (!city) { setPostcode(''); return; }
    if (postcode && !city.postcodes.some((entry) => entry.postcode === postcode)) setPostcode('');
  }, [city, postcode]);

  const candidates = useMemo(() => {
    if (!city) return [];
    const nodes = postcode ? city.postcodes.filter((entry) => entry.postcode === postcode) : city.postcodes;
    return nodes.flatMap((entry) => entry.addresses);
  }, [city, postcode]);
  const generate = () => { setResult(randomItem(candidates)); setCopied(false); };
  const countryName = country ? locale === 'zh-CN' ? country.nameZh : country.name : '';
  const resultAddress = result ? formatLiteAddressLines(result, countryName) : undefined;

  if (!index && !error) return <main className="lite-shell"><div className="lite-card lite-loading">{t.loading}</div></main>;
  return <main className="lite-shell">
    <section className="lite-hero">
      <div><span className="lite-kicker">ULTRA LITE</span><h1>{t.title}</h1><p className="lite-subtitle">{t.subtitle}</p><p className="lite-mobile-subtitle">{t.mobileSubtitle}</p>
        {index && <p className="lite-mobile-stats"><strong>{index.totalAddresses.toLocaleString(locale)}</strong> {t.mobileAddresses} · <strong>{index.countries.length.toLocaleString(locale)}</strong> {t.mobileCountries}</p>}
      </div>
      {index && <div className="lite-build"><strong>{index.totalAddresses.toLocaleString()}</strong><span>{t.addresses}</span><small>{new Date(index.generatedAt).toLocaleString(locale)}</small></div>}
    </section>

    <section className="lite-card lite-controls">
      <label><span>{t.country}</span><select value={countryCode} onChange={(event) => setCountryCode(event.target.value)}>
        {index?.countries.map((entry) => <option key={entry.code} value={entry.code}>{locale === 'zh-CN' ? entry.nameZh : entry.name} ({entry.code})</option>)}
      </select></label>

      <div className="lite-field"><span>{t.category}</span><div className="lite-tabs">
        <button className={category === 'low_tax' ? 'active' : ''} disabled={!availableCategories.has('low_tax')} onClick={() => setCategory('low_tax')}>{t.low}</button>
        <button className={category === 'major_city' ? 'active' : ''} disabled={!availableCategories.has('major_city')} onClick={() => setCategory('major_city')}>{t.cities}</button>
      </div></div>

      {targets.length ? <label><span>{t.target}</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
        {targets.map((entry) => <option key={entry.id} value={entry.id}>{locale === 'zh-CN' ? entry.labelZh : entry.label} · {entry.addresses} {t.addresses}</option>)}
      </select></label> : <p className="lite-muted">{t.unavailable}</p>}

      {category === 'low_tax' && target?.tax && <div className="lite-tax">
        <div><strong>{t.taxType}</strong><span>{taxTypeLabels[locale][target.tax.type]}</span></div>
        <div><strong>{t.taxReference}</strong><span>{formatTaxReference(target.tax, locale)}</span></div>
      </div>}
      {loading && <p className="lite-muted">{t.loading}</p>}
      {error && <p className="lite-error">{error}</p>}

      {payload && <div className="lite-grid">
        <label><span>{t.region}</span><select value={regionName} onChange={(event) => { setRegionName(event.target.value); setResult(undefined); }}>
          {payload.regions.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
        </select></label>
        <label><span>{t.city}</span><select value={cityName} onChange={(event) => { setCityName(event.target.value); setPostcode(''); setResult(undefined); }}>
          {region?.cities.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
        </select></label>
        <label><span>{t.postcode}</span><select value={postcode} onChange={(event) => { setPostcode(event.target.value); setResult(undefined); }}>
          <option value="">{t.any}</option>{city?.postcodes.map((entry) => <option key={entry.postcode || '__blank'} value={entry.postcode}>{entry.postcode || '—'} ({entry.addresses.length})</option>)}
        </select></label>
      </div>}
      <button className="lite-generate" disabled={!candidates.length} onClick={generate}>{result ? t.another : t.generate}</button>
      {payload && <p className="lite-summary">{payload.stats.addresses} {t.addresses} · {payload.stats.postcodes} {t.postcodes}</p>}
    </section>

    {result ? <section className="lite-card lite-result">
      <div className="lite-result-head"><span className="lite-verified">✓ {t.verified}</span><span>{Math.round(result.qualityScore * 100)}%</span></div>
      <div className="lite-address-heading"><h2>{resultAddress?.lines[0] || '—'}</h2>{resultAddress?.lines.slice(1).map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div>
      <dl>
        <div><dt>{t.region}</dt><dd>{result.region || '—'}</dd></div><div><dt>{t.city}</dt><dd>{result.city || result.locality || '—'}</dd></div>
        <div><dt>{t.postcode}</dt><dd>{result.postcode || '—'}</dd></div><div><dt>{t.location}</dt><dd>{result.latitude.toFixed(6)}, {result.longitude.toFixed(6)}</dd></div>
      </dl>
      <div className="lite-actions"><button onClick={async () => { await copyText(resultAddress?.copyText || ''); setCopied(true); }}>{copied ? t.copied : t.copy}</button></div>
      <footer><span>{t.source}: {result.source.name}</span>{result.source.license && <span>{result.source.license}</span>}<span>{t.updated}: {payload?.generatedAt ? new Date(payload.generatedAt).toLocaleDateString(locale) : '—'}</span></footer>
    </section> : payload && !candidates.length ? <section className="lite-card lite-empty">{t.noData}</section> : null}
  </main>;
}
