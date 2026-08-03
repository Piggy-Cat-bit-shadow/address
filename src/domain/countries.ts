import type {
  AddressResultFieldDefinition,
  AddressResultField,
  CountryAddressSchema,
  CountryCode,
  CountryConfig,
  CountryGroup,
  LocalizedText,
  LocationShortcut,
  Readiness,
  SourceDefinition
} from './types.ts';

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh });

const shortcuts = (
  type: LocationShortcut['type'],
  entries: Array<[string, string, string]>
): LocationShortcut[] => entries.map(([en, zh, value]) => ({ label: text(en, zh), value, type }));

const source = (
  id: string,
  name: string,
  url: string,
  role: SourceDefinition['role'],
  updateCadence: string,
  priority: SourceDefinition['priority'] = 'primary'
): SourceDefinition => ({ id, name, url, role, updateCadence, priority });

const fallbacks = (residential: boolean): SourceDefinition[] => [
  source(
    'osm-overpass',
    'OpenStreetMap / Overpass',
    'https://wiki.openstreetmap.org/wiki/Overpass_API',
    residential ? 'residential' : 'address',
    'live',
    'fallback'
  )
];

interface Definition {
  code: CountryCode;
  en: string;
  zh: string;
  nativeName: string;
  nativeLanguage: string;
  flag: string;
  callingCode: string;
  group: CountryGroup;
  order: number;
  readiness: Readiness;
  residential: boolean;
  googleValidation: boolean;
  googleResidential: boolean;
  format: string;
  latinFormat?: string;
  center: [number, number];
  adminLabel: [string, string];
  postcodeLabel?: [string, string];
  primary: SourceDefinition[];
  cities: Array<[string, string, string]>;
  admins: Array<[string, string, string]>;
  specialLabel?: [string, string];
  special?: Array<[string, string, string, LocationShortcut['type']]>;
}

const localityLabels: Partial<Record<CountryCode, LocalizedText>> = {
  US: text('Postal city', '邮政城市'),
  JP: text('Municipality', '市区町村'),
  HK: text('District', '行政区'),
  SG: text('Planning area', '规划区'),
  TW: text('Township', '乡镇市区'),
  CN: text('City', '城市')
};

const districtLabels: Partial<Record<CountryCode, LocalizedText>> = {
  MX: text('Colonia', '居民区'),
  JP: text('Ward', '区市町村'),
  HK: text('Locality', '地点'),
  TW: text('District', '区乡镇'),
  KR: text('District', '区郡'),
  MY: text('District', '县区'),
  CN: text('District', '区县'),
  PH: text('Barangay', '描笼涯'),
  TH: text('Subdistrict', '分区'),
  ZA: text('Suburb', '街区'),
  IN: text('District', '县区')
};

const adminCodeLabel = (definition: Definition): LocalizedText => {
  const english = definition.adminLabel[0];
  if (english.startsWith('State')) return text('State abbreviation', '州缩写');
  if (english.startsWith('Province')) return text('Province abbreviation', '省缩写');
  if (english.startsWith('Prefecture')) return text('Prefecture abbreviation', '都道府县缩写');
  if (english.startsWith('County')) return text('County abbreviation', '县市缩写');
  if (english.startsWith('Region')) return text('Region abbreviation', '地域缩写');
  return text('Administrative abbreviation', '行政区缩写');
};

const detailFields: Record<CountryCode, Array<'locality' | 'district' | 'admin1' | 'postcode'>> = {
  US: ['locality', 'admin1', 'postcode'],
  CA: ['locality', 'admin1', 'postcode'],
  MX: ['district', 'locality', 'admin1', 'postcode'],
  GB: ['locality', 'postcode'],
  DE: ['locality', 'postcode'],
  FR: ['locality', 'postcode'],
  IT: ['locality', 'admin1', 'postcode'],
  ES: ['locality', 'admin1', 'postcode'],
  NL: ['locality', 'postcode'],
  RU: ['locality', 'admin1', 'postcode'],
  JP: ['admin1', 'locality', 'district', 'postcode'],
  HK: ['admin1', 'locality', 'district'],
  SG: ['postcode'],
  TW: ['admin1', 'locality', 'district', 'postcode'],
  KR: ['admin1', 'locality', 'district', 'postcode'],
  MY: ['district', 'locality', 'admin1', 'postcode'],
  CN: ['admin1', 'locality', 'district', 'postcode'],
  TH: ['district', 'locality', 'admin1', 'postcode'],
  PH: ['district', 'locality', 'admin1', 'postcode'],
  VN: ['locality', 'admin1', 'postcode'],
  TR: ['locality', 'admin1', 'postcode'],
  SA: ['locality', 'postcode'],
  IN: ['district', 'locality', 'admin1', 'postcode'],
  AU: ['locality', 'admin1', 'postcode'],
  BR: ['locality', 'admin1', 'postcode'],
  NG: ['locality', 'admin1', 'postcode'],
  ZA: ['district', 'locality', 'postcode']
};

const addressSchema = (definition: Definition): CountryAddressSchema => {
  const labelFor = (field: AddressResultField): LocalizedText => {
    if (field === 'country') return text('Country', '国家');
    if (field === 'buildingName') return text('Residential community', '小区名称');
    if (field === 'street') return text('Street address', '街道地址');
    if (field === 'completeAddress') return text('Complete address', '完整地址');
    if (field === 'locality') return localityLabels[definition.code] || text('City', '城市');
    if (field === 'district') return districtLabels[definition.code] || text('District', '区县');
    if (field === 'admin1') return text(...definition.adminLabel);
    if (field === 'admin1Code') return adminCodeLabel(definition);
    return text(...(definition.postcodeLabel || ['Postcode', '邮编']));
  };
  const configuredDetails = new Set(detailFields[definition.code]);
  const hierarchy: AddressResultField[] = ['district', 'locality', 'admin1', 'postcode'];
  const details = hierarchy.flatMap((field): AddressResultField[] => {
    if (!configuredDetails.has(field as 'locality' | 'district' | 'admin1' | 'postcode')) return [];
    return field === 'admin1' ? [field, 'admin1Code'] : [field];
  });
  const fields: AddressResultField[] = [
    ...(definition.code === 'CN' ? ['buildingName' as const] : []),
    'street', ...details, 'completeAddress'
  ];
  const resultFields: AddressResultFieldDefinition[] = fields.map((field) => ({ field, label: labelFor(field) }));
  return {
    filters: definition.code === 'CN'
      ? ['region', 'city', 'district']
      : ['HK', 'US'].includes(definition.code)
        ? ['region', 'city']
        : definition.code === 'SG'
          ? ['postcode']
          : ['region', 'city', 'postcode'],
    resultFields,
    postalAdmin1Style: ['US', 'AU', 'CA', 'BR'].includes(definition.code) ? 'code' : 'name'
  };
};

const makeCountry = (definition: Definition): CountryConfig => {
  const schema = addressSchema(definition);
  return {
    code: definition.code,
    name: { en: definition.en, 'zh-CN': definition.zh },
    nativeName: definition.nativeName,
    nativeLanguage: definition.nativeLanguage,
    flag: definition.flag,
    callingCode: definition.callingCode,
    group: definition.group,
    order: definition.order,
    readiness: definition.readiness,
    residentialCapability: definition.residential,
    googleAddressValidation: definition.googleValidation,
    googleResidentialMetadata: definition.googleResidential,
    searchLabels: {
      query: text('City, region or postcode', '搜索城市、行政区或邮编'),
      region: text(...definition.adminLabel),
      city: localityLabels[definition.code] || text('City', '城市'),
      ...(schema.filters.includes('district')
        ? { district: districtLabels[definition.code] || text('District', '区县') }
        : {}),
      postcode: text(...(definition.postcodeLabel || ['Postcode', '邮编'] as [string, string]))
    },
    addressFormat: { native: definition.format, latin: definition.latinFormat },
    addressSchema: schema,
    fallbackCenter: { latitude: definition.center[0], longitude: definition.center[1] },
    popularCities: shortcuts('city', definition.cities),
    adminShortcuts: shortcuts('region', definition.admins),
    specialAreaTitle: text(...(definition.specialLabel || ['Special areas', '特殊地区'])),
    specialAreas: (definition.special || []).map(([en, zh, value, type]) => ({
      label: text(en, zh), value, type
    })),
    sources: [...definition.primary, ...fallbacks(definition.residential)]
  };
};

export const countries: CountryConfig[] = [
  makeCountry({
    code: 'US', en: 'United States', zh: '美国', nativeName: 'United States', nativeLanguage: 'en', flag: '🇺🇸', callingCode: '+1',
    group: 'north-america', order: 1, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C, %S %Z', center: [40.681, -73.975], adminLabel: ['State', '州'], postcodeLabel: ['ZIP code', '邮政编码'],
    primary: [source('nad', 'National Address Database', 'https://www.transportation.gov/gis/national-address-database', 'address', 'release-triggered')],
    cities: [
      ['New York', '纽约', 'New York'], ['Los Angeles', '洛杉矶', 'Los Angeles'], ['Chicago', '芝加哥', 'Chicago'],
      ['Houston', '休斯敦', 'Houston'], ['Phoenix', '菲尼克斯', 'Phoenix'], ['Philadelphia', '费城', 'Philadelphia'],
      ['San Antonio', '圣安东尼奥', 'San Antonio'], ['San Diego', '圣迭戈', 'San Diego'], ['Dallas', '达拉斯', 'Dallas'],
      ['San Francisco', '旧金山', 'San Francisco'], ['Seattle', '西雅图', 'Seattle'], ['Boston', '波士顿', 'Boston']
    ],
    admins: [
      ['California', '加利福尼亚州', 'CA'], ['Texas', '得克萨斯州', 'TX'], ['Florida', '佛罗里达州', 'FL'],
      ['New York', '纽约州', 'NY'], ['Washington', '华盛顿州', 'WA'], ['Illinois', '伊利诺伊州', 'IL'],
      ['Massachusetts', '马萨诸塞州', 'MA'], ['New Jersey', '新泽西州', 'NJ'], ['Pennsylvania', '宾夕法尼亚州', 'PA'],
      ['Georgia', '佐治亚州', 'GA'], ['Virginia', '弗吉尼亚州', 'VA'], ['Nevada', '内华达州', 'NV']
    ],
    specialLabel: ['States without statewide sales tax', '无州级销售税州'],
    special: [
      ['Alaska', '阿拉斯加州', 'AK', 'region'],
      ['Delaware', '特拉华州', 'DE', 'region'],
      ['Montana', '蒙大拿州', 'MT', 'region'],
      ['New Hampshire', '新罕布什尔州', 'NH', 'region'],
      ['Oregon', '俄勒冈州', 'OR', 'region']
    ]
  }),
  makeCountry({
    code: 'CA', en: 'Canada', zh: '加拿大', nativeName: 'Canada', nativeLanguage: 'en', flag: '🇨🇦', callingCode: '+1',
    group: 'north-america', order: 2, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C %S %Z', center: [43.653, -79.383], adminLabel: ['Province', '省'], postcodeLabel: ['Postal code', '邮政编码'],
    primary: [source('nar', 'Statistics Canada National Address Register', 'https://www.statcan.gc.ca/en/lode/databases/oda', 'address', 'semiannual')],
    cities: [['Toronto', '多伦多', 'Toronto'], ['Vancouver', '温哥华', 'Vancouver'], ['Montréal', '蒙特利尔', 'Montréal'], ['Calgary', '卡尔加里', 'Calgary'], ['Ottawa', '渥太华', 'Ottawa'], ['Edmonton', '埃德蒙顿', 'Edmonton'], ['Québec City', '魁北克市', 'Québec'], ['Winnipeg', '温尼伯', 'Winnipeg']],
    admins: [['Ontario', '安大略省', 'ON'], ['British Columbia', '不列颠哥伦比亚省', 'BC'], ['Québec', '魁北克省', 'QC'], ['Alberta', '阿尔伯塔省', 'AB'], ['Manitoba', '曼尼托巴省', 'MB'], ['Nova Scotia', '新斯科舍省', 'NS']]
  }),
  makeCountry({
    code: 'MX', en: 'Mexico', zh: '墨西哥', nativeName: 'México', nativeLanguage: 'es', flag: '🇲🇽', callingCode: '+52',
    group: 'north-america', order: 3, readiness: 'partial', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%D%n%Z %C, %S', center: [19.4326, -99.1332], adminLabel: ['State', '州'], postcodeLabel: ['Código postal', '邮编'],
    primary: [source('inegi', 'INEGI', 'https://www.inegi.org.mx/app/mapa/espacioydatos/default.aspx', 'address', 'version-triggered')],
    cities: [['Mexico City', '墨西哥城', 'Ciudad de México'], ['Guadalajara', '瓜达拉哈拉', 'Guadalajara'], ['Monterrey', '蒙特雷', 'Monterrey'], ['Puebla', '普埃布拉', 'Puebla'], ['Tijuana', '蒂华纳', 'Tijuana'], ['León', '莱昂', 'León'], ['Mérida', '梅里达', 'Mérida'], ['Querétaro', '克雷塔罗', 'Santiago de Querétaro']],
    admins: [['Ciudad de México', '墨西哥城', 'Ciudad de México'], ['Jalisco', '哈利斯科州', 'Jalisco'], ['Nuevo León', '新莱昂州', 'Nuevo León'], ['México', '墨西哥州', 'México'], ['Puebla', '普埃布拉州', 'Puebla'], ['Yucatán', '尤卡坦州', 'Yucatán']]
  }),

  makeCountry({
    code: 'GB', en: 'United Kingdom', zh: '英国', nativeName: 'United Kingdom', nativeLanguage: 'en', flag: '🇬🇧', callingCode: '+44',
    group: 'europe', order: 4, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C%n%Z', center: [51.507, -0.127], adminLabel: ['Constituent country', '构成国'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('uprn', 'OS Open UPRN', 'https://www.ordnancesurvey.co.uk/products/os-open-uprn', 'address', 'six-weekly')],
    cities: [['London', '伦敦', 'London'], ['Manchester', '曼彻斯特', 'Manchester'], ['Edinburgh', '爱丁堡', 'Edinburgh'], ['Birmingham', '伯明翰', 'Birmingham'], ['Glasgow', '格拉斯哥', 'Glasgow'], ['Liverpool', '利物浦', 'Liverpool'], ['Bristol', '布里斯托尔', 'Bristol'], ['Leeds', '利兹', 'Leeds'], ['Cardiff', '加的夫', 'Cardiff'], ['Belfast', '贝尔法斯特', 'Belfast']],
    admins: [['England', '英格兰', 'England'], ['Scotland', '苏格兰', 'Scotland'], ['Wales', '威尔士', 'Wales'], ['Northern Ireland', '北爱尔兰', 'Northern Ireland']]
  }),
  makeCountry({
    code: 'DE', en: 'Germany', zh: '德国', nativeName: 'Deutschland', nativeLanguage: 'de', flag: '🇩🇪', callingCode: '+49',
    group: 'europe', order: 5, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%Z %C', center: [52.52, 13.405], adminLabel: ['State', '联邦州'], postcodeLabel: ['Postleitzahl', '邮编'],
    primary: [source('hkde', 'BKG House Coordinates', 'https://gdz.bkg.bund.de/', 'address', 'version-triggered')],
    cities: [['Berlin', '柏林', 'Berlin'], ['Munich', '慕尼黑', 'München'], ['Frankfurt', '法兰克福', 'Frankfurt am Main'], ['Hamburg', '汉堡', 'Hamburg'], ['Cologne', '科隆', 'Köln'], ['Düsseldorf', '杜塞尔多夫', 'Düsseldorf'], ['Stuttgart', '斯图加特', 'Stuttgart'], ['Leipzig', '莱比锡', 'Leipzig']],
    admins: [['Berlin', '柏林州', 'Berlin'], ['Bavaria', '巴伐利亚州', 'Bayern'], ['Hesse', '黑森州', 'Hessen'], ['North Rhine-Westphalia', '北莱茵-威斯特法伦州', 'Nordrhein-Westfalen'], ['Baden-Württemberg', '巴登-符腾堡州', 'Baden-Württemberg'], ['Hamburg', '汉堡州', 'Hamburg']]
  }),
  makeCountry({
    code: 'FR', en: 'France', zh: '法国', nativeName: 'France', nativeLanguage: 'fr', flag: '🇫🇷', callingCode: '+33',
    group: 'europe', order: 6, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%Z %C', center: [48.856, 2.352], adminLabel: ['Region', '大区'], postcodeLabel: ['Code postal', '邮编'],
    primary: [source('ban', 'Base Adresse Nationale', 'https://adresse.data.gouv.fr/', 'address', 'twice-weekly'), source('bdnb', 'BDNB', 'https://bdnb.io/', 'residential', 'version-triggered')],
    cities: [['Paris', '巴黎', 'Paris'], ['Lyon', '里昂', 'Lyon'], ['Marseille', '马赛', 'Marseille'], ['Toulouse', '图卢兹', 'Toulouse'], ['Nice', '尼斯', 'Nice'], ['Bordeaux', '波尔多', 'Bordeaux'], ['Lille', '里尔', 'Lille'], ['Nantes', '南特', 'Nantes']],
    admins: [['Île-de-France', '法兰西岛大区', 'Île-de-France'], ['Auvergne-Rhône-Alpes', '奥弗涅-罗讷-阿尔卑斯大区', 'Auvergne-Rhône-Alpes'], ["Provence-Alpes-Côte d'Azur", '普罗旺斯-阿尔卑斯-蓝色海岸大区', "Provence-Alpes-Côte d'Azur"], ['Occitanie', '奥克西塔尼大区', 'Occitanie'], ['Nouvelle-Aquitaine', '新阿基坦大区', 'Nouvelle-Aquitaine']]
  }),
  makeCountry({
    code: 'IT', en: 'Italy', zh: '意大利', nativeName: 'Italia', nativeLanguage: 'it', flag: '🇮🇹', callingCode: '+39',
    group: 'europe', order: 7, readiness: 'partial', residential: true, googleValidation: true, googleResidential: false,
    format: '%N%n%O%n%A%n%Z %C %S', center: [41.902, 12.496], adminLabel: ['Region', '大区'], postcodeLabel: ['CAP', '邮编'],
    primary: [source('anncsu', 'ANNCSU', 'https://www.anncsu.gov.it/', 'address', 'version-triggered')],
    cities: [['Rome', '罗马', 'Roma'], ['Milan', '米兰', 'Milano'], ['Florence', '佛罗伦萨', 'Firenze'], ['Naples', '那不勒斯', 'Napoli'], ['Turin', '都灵', 'Torino'], ['Bologna', '博洛尼亚', 'Bologna'], ['Venice', '威尼斯', 'Venezia'], ['Palermo', '巴勒莫', 'Palermo']],
    admins: [['Lazio', '拉齐奥大区', 'Lazio'], ['Lombardy', '伦巴第大区', 'Lombardia'], ['Tuscany', '托斯卡纳大区', 'Toscana'], ['Campania', '坎帕尼亚大区', 'Campania'], ['Piedmont', '皮埃蒙特大区', 'Piemonte']]
  }),
  makeCountry({
    code: 'ES', en: 'Spain', zh: '西班牙', nativeName: 'España', nativeLanguage: 'es', flag: '🇪🇸', callingCode: '+34',
    group: 'europe', order: 8, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%Z %C %S', center: [40.416, -3.703], adminLabel: ['Province', '省'], postcodeLabel: ['Código postal', '邮编'],
    primary: [source('cartociudad', 'CartoCiudad', 'https://www.cartociudad.es/', 'address', 'version-triggered'), source('catastro', 'Catastro', 'https://www.sedecatastro.gob.es/', 'residential', 'version-triggered')],
    cities: [['Madrid', '马德里', 'Madrid'], ['Barcelona', '巴塞罗那', 'Barcelona'], ['Valencia', '瓦伦西亚', 'València'], ['Seville', '塞维利亚', 'Sevilla'], ['Zaragoza', '萨拉戈萨', 'Zaragoza'], ['Málaga', '马拉加', 'Málaga'], ['Bilbao', '毕尔巴鄂', 'Bilbao'], ['Alicante', '阿利坎特', 'Alicante']],
    admins: [['Madrid', '马德里自治区', 'Comunidad de Madrid'], ['Catalonia', '加泰罗尼亚', 'Cataluña'], ['Andalusia', '安达卢西亚自治区', 'Andalucía'], ['Valencian Community', '瓦伦西亚自治区', 'Comunitat Valenciana'], ['Basque Country', '巴斯克自治区', 'País Vasco']]
  }),
  makeCountry({
    code: 'NL', en: 'Netherlands', zh: '荷兰', nativeName: 'Nederland', nativeLanguage: 'nl', flag: '🇳🇱', callingCode: '+31',
    group: 'europe', order: 9, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%Z %C', center: [52.37, 4.895], adminLabel: ['Province', '省'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('bag', 'BAG / PDOK', 'https://api.pdok.nl/kadaster/bag/ogc/v2', 'residential', 'daily')],
    cities: [['Amsterdam', '阿姆斯特丹', 'Amsterdam'], ['Rotterdam', '鹿特丹', 'Rotterdam'], ['The Hague', '海牙', 'Den Haag'], ['Utrecht', '乌得勒支', 'Utrecht'], ['Eindhoven', '埃因霍温', 'Eindhoven'], ['Groningen', '格罗宁根', 'Groningen']],
    admins: [['North Holland', '北荷兰省', 'Noord-Holland'], ['South Holland', '南荷兰省', 'Zuid-Holland'], ['Utrecht', '乌得勒支省', 'Utrecht'], ['North Brabant', '北布拉班特省', 'Noord-Brabant']]
  }),
  makeCountry({
    code: 'RU', en: 'Russia', zh: '俄罗斯', nativeName: 'Россия', nativeLanguage: 'ru', flag: '🇷🇺', callingCode: '+7',
    group: 'europe', order: 10, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%S%n%Z', latinFormat: '%N%n%O%n%A%n%C%n%S%n%Z', center: [55.755, 37.617], adminLabel: ['Federal subject', '联邦主体'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('fias', 'GAR / FIAS', 'https://www.nalog.gov.ru/opendata/7707329152-fias', 'address', 'weekly')],
    cities: [['Moscow', '莫斯科', 'Москва'], ['Saint Petersburg', '圣彼得堡', 'Санкт-Петербург'], ['Kazan', '喀山', 'Казань'], ['Novosibirsk', '新西伯利亚', 'Новосибирск'], ['Yekaterinburg', '叶卡捷琳堡', 'Екатеринбург'], ['Nizhny Novgorod', '下诺夫哥罗德', 'Нижний Новгород'], ['Samara', '萨马拉', 'Самара'], ['Omsk', '鄂木斯克', 'Омск'], ['Rostov-on-Don', '顿河畔罗斯托夫', 'Ростов-на-Дону'], ['Vladivostok', '符拉迪沃斯托克', 'Владивосток']],
    admins: [['Moscow', '莫斯科', 'Москва'], ['Saint Petersburg', '圣彼得堡', 'Санкт-Петербург'], ['Moscow Oblast', '莫斯科州', 'Московская область'], ['Republic of Tatarstan', '鞑靼斯坦共和国', 'Республика Татарстан'], ['Sverdlovsk Oblast', '斯维尔德洛夫斯克州', 'Свердловская область'], ['Novosibirsk Oblast', '新西伯利亚州', 'Новосибирская область'], ['Krasnodar Krai', '克拉斯诺达尔边疆区', 'Краснодарский край'], ['Primorsky Krai', '滨海边疆区', 'Приморский край']]
  }),

  makeCountry({
    code: 'JP', en: 'Japan', zh: '日本', nativeName: '日本', nativeLanguage: 'ja', flag: '🇯🇵', callingCode: '+81',
    group: 'east-asia', order: 14, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '〒%Z%n%S%C%D%n%A%n%O%n%N', latinFormat: '%N%n%O%n%A%n%D%n%C, %S%n%Z', center: [35.676, 139.65], adminLabel: ['Prefecture', '都道府县'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('abr', 'Address Base Registry', 'https://www.digital.go.jp/en/policies/base_registry_address', 'address', 'version-triggered')],
    cities: [['Tokyo', '东京', '新宿区'], ['Osaka', '大阪', '大阪市'], ['Yokohama', '横滨', '横浜市'], ['Nagoya', '名古屋', '名古屋市'], ['Sapporo', '札幌', '札幌市'], ['Fukuoka', '福冈', '福岡市'], ['Kyoto', '京都', '京都市'], ['Kobe', '神户', '神戸市'], ['Kawasaki', '川崎', '川崎市'], ['Saitama', '埼玉', 'さいたま市']],
    admins: [['Tokyo', '东京都', '東京都'], ['Osaka', '大阪府', '大阪府'], ['Kanagawa', '神奈川县', '神奈川県'], ['Aichi', '爱知县', '愛知県'], ['Hokkaido', '北海道', '北海道'], ['Fukuoka', '福冈县', '福岡県'], ['Kyoto', '京都府', '京都府'], ['Hyogo', '兵库县', '兵庫県']]
  }),
  makeCountry({
    code: 'HK', en: 'Hong Kong', zh: '香港', nativeName: '香港', nativeLanguage: 'zh-HK', flag: '🇭🇰', callingCode: '+852',
    group: 'east-asia', order: 12, readiness: 'strict', residential: true, googleValidation: false, googleResidential: false,
    format: '%S%n%C%n%D%n%A%n%O%n%N', latinFormat: '%N%n%O%n%D%n%A%n%C%n%S', center: [22.319, 114.169], adminLabel: ['Region', '地域'], postcodeLabel: ['Postcode (not used)', '邮编（不使用）'],
    primary: [source('hk-als', 'Hong Kong Address Lookup Service', 'https://www.als.gov.hk/', 'address', 'live')],
    cities: [['Central', '中环', 'Central'], ['Wan Chai', '湾仔', 'Wan Chai'], ['Causeway Bay', '铜锣湾', 'Causeway Bay'], ['Tsim Sha Tsui', '尖沙咀', 'Tsim Sha Tsui'], ['Mong Kok', '旺角', 'Mong Kok'], ['Kowloon Tong', '九龙塘', 'Kowloon Tong'], ['Kwun Tong', '观塘', 'Kwun Tong'], ['Sha Tin', '沙田', 'Sha Tin'], ['Tsuen Wan', '荃湾', 'Tsuen Wan'], ['Tuen Mun', '屯门', 'Tuen Mun'], ['Yuen Long', '元朗', 'Yuen Long'], ['Tseung Kwan O', '将军澳', 'Tseung Kwan O']],
    admins: [['Central and Western', '中西区', 'Central and Western'], ['Wan Chai', '湾仔区', 'Wan Chai'], ['Kowloon City', '九龙城区', 'Kowloon City'], ['Yau Tsim Mong', '油尖旺区', 'Yau Tsim Mong'], ['Kwun Tong', '观塘区', 'Kwun Tong'], ['Sha Tin', '沙田区', 'Sha Tin'], ['Tsuen Wan', '荃湾区', 'Tsuen Wan'], ['Yuen Long', '元朗区', 'Yuen Long']]
  }),
  makeCountry({
    code: 'SG', en: 'Singapore', zh: '新加坡', nativeName: 'Singapore', nativeLanguage: 'en', flag: '🇸🇬', callingCode: '+65',
    group: 'east-asia', order: 15, readiness: 'strict', residential: true, googleValidation: true, googleResidential: false,
    format: '%N%n%O%n%A%nSINGAPORE %Z', center: [1.352, 103.819], adminLabel: ['Planning area', '规划区'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('onemap', 'OneMap', 'https://www.onemap.gov.sg/apidocs/search', 'address', 'live'), source('hdb', 'HDB Property Information', 'https://data.gov.sg/datasets/d_17f5382f26140b1fdae0ba2ef6239d2f/view', 'residential', 'version-triggered')],
    cities: [['Central Area', '中央区', 'Central Area'], ['Bedok', '勿洛', 'Bedok'], ['Ang Mo Kio', '宏茂桥', 'Ang Mo Kio'], ['Tampines', '淡滨尼', 'Tampines'], ['Jurong East', '裕廊东', 'Jurong East'], ['Queenstown', '女皇镇', 'Queenstown'], ['Bukit Merah', '红山', 'Bukit Merah'], ['Woodlands', '兀兰', 'Woodlands']],
    admins: [['Central Region', '中区', 'Central Region'], ['East Region', '东区', 'East Region'], ['North-East Region', '东北区', 'North-East Region'], ['West Region', '西区', 'West Region'], ['North Region', '北区', 'North Region']]
  }),
  makeCountry({
    code: 'TW', en: 'Taiwan', zh: '台湾', nativeName: '臺灣', nativeLanguage: 'zh-TW', flag: '🇹🇼', callingCode: '+886',
    group: 'east-asia', order: 13, readiness: 'strict', residential: true, googleValidation: false, googleResidential: false,
    format: '%Z%n%S%C%n%A%n%O%n%N', latinFormat: '%N%n%O%n%A%n%C, %S %Z', center: [25.033, 121.565], adminLabel: ['County and city', '县市'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('tgos', 'TGOS Address Locator', 'https://api.tgos.tw/TGOS_MAP_API/docs/site/web/Locate', 'address', 'live')],
    cities: [['Taipei', '台北', '臺北市'], ['Kaohsiung', '高雄', '高雄市'], ['Taichung', '台中', '臺中市'], ['New Taipei', '新北', '新北市'], ['Tainan', '台南', '臺南市'], ['Taoyuan', '桃园', '桃園市'], ['Hsinchu', '新竹', '新竹市'], ['Keelung', '基隆', '基隆市']],
    admins: [['Taipei City', '台北市', '臺北市'], ['New Taipei City', '新北市', '新北市'], ['Taichung City', '台中市', '臺中市'], ['Kaohsiung City', '高雄市', '高雄市'], ['Tainan City', '台南市', '臺南市'], ['Taoyuan City', '桃园市', '桃園市']]
  }),
  makeCountry({
    code: 'KR', en: 'South Korea', zh: '韩国', nativeName: '대한민국', nativeLanguage: 'ko', flag: '🇰🇷', callingCode: '+82',
    group: 'east-asia', order: 16, readiness: 'strict', residential: true, googleValidation: false, googleResidential: false,
    format: '%S %C%n%A%n%O%n%N%n(%Z)', latinFormat: '%N%n%O%n%A%n%C%n%S%n%Z', center: [37.566, 126.978], adminLabel: ['Province and metropolitan city', '道与广域市'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('kapt', 'K-apt Official Apartment Complexes', 'https://www.k-apt.go.kr/', 'residential', 'daily')],
    cities: [['Seoul', '首尔', '서울특별시'], ['Busan', '釜山', '부산광역시'], ['Incheon', '仁川', '인천광역시'], ['Daegu', '大邱', '대구광역시'], ['Daejeon', '大田', '대전광역시'], ['Gwangju', '光州', '광주광역시'], ['Suwon', '水原', '수원시'], ['Ulsan', '蔚山', '울산광역시']],
    admins: [['Seoul', '首尔特别市', '서울특별시'], ['Gyeonggi', '京畿道', '경기도'], ['Busan', '釜山广域市', '부산광역시'], ['Incheon', '仁川广域市', '인천광역시'], ['South Gyeongsang', '庆尚南道', '경상남도'], ['North Gyeongsang', '庆尚北道', '경상북도']]
  }),
  makeCountry({
    code: 'MY', en: 'Malaysia', zh: '马来西亚', nativeName: 'Malaysia', nativeLanguage: 'ms', flag: '🇲🇾', callingCode: '+60',
    group: 'southeast-asia', order: 20, readiness: 'research', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%D%n%Z %C%n%S', center: [3.139, 101.686], adminLabel: ['State', '州'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('mygeoportal', 'MyGeoportal', 'https://www.mygeoportal.gov.my/', 'address', 'provider-managed')],
    cities: [['Kuala Lumpur', '吉隆坡', 'Kuala Lumpur'], ['George Town', '乔治市', 'George Town'], ['Johor Bahru', '新山', 'Johor Bahru'], ['Shah Alam', '莎阿南', 'Shah Alam'], ['Petaling Jaya', '八打灵再也', 'Petaling Jaya'], ['Kota Kinabalu', '亚庇', 'Kota Kinabalu']],
    admins: [['Kuala Lumpur', '吉隆坡', 'Kuala Lumpur'], ['Selangor', '雪兰莪州', 'Selangor'], ['Johor', '柔佛州', 'Johor'], ['Penang', '槟城州', 'Pulau Pinang'], ['Sabah', '沙巴州', 'Sabah']]
  }),
  makeCountry({
    code: 'CN', en: 'China', zh: '中国', nativeName: '中国', nativeLanguage: 'zh-CN', flag: '🇨🇳', callingCode: '+86',
    group: 'east-asia', order: 11, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%S%C%D%n%A%n%O%n%N', latinFormat: '%N%n%O%n%A%n%D%n%C%n%S', center: [31.23, 121.47], adminLabel: ['Province-level region', '省级行政区'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('ngcc', 'National Platform for Common Geospatial Information Services', 'https://www.tianditu.gov.cn/', 'address', 'provider-managed')],
    cities: [['Beijing', '北京', '北京市'], ['Shanghai', '上海', '上海市'], ['Guangzhou', '广州', '广州市'], ['Shenzhen', '深圳', '深圳市'], ['Chengdu', '成都', '成都市'], ['Chongqing', '重庆', '重庆市'], ['Hangzhou', '杭州', '杭州市'], ['Wuhan', '武汉', '武汉市'], ['Nanjing', '南京', '南京市'], ["Xi'an", '西安', '西安市'], ['Suzhou', '苏州', '苏州市'], ['Tianjin', '天津', '天津市']],
    admins: [['Beijing', '北京市', '北京市'], ['Shanghai', '上海市', '上海市'], ['Guangdong', '广东省', '广东省'], ['Zhejiang', '浙江省', '浙江省'], ['Jiangsu', '江苏省', '江苏省'], ['Sichuan', '四川省', '四川省'], ['Shandong', '山东省', '山东省'], ['Hubei', '湖北省', '湖北省'], ['Fujian', '福建省', '福建省'], ['Henan', '河南省', '河南省'], ['Chongqing', '重庆市', '重庆市'], ['Tianjin', '天津市', '天津市']]
  }),
  makeCountry({
    code: 'TH', en: 'Thailand', zh: '泰国', nativeName: 'ประเทศไทย', nativeLanguage: 'th', flag: '🇹🇭', callingCode: '+66',
    group: 'southeast-asia', order: 18, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%S %Z', latinFormat: '%N%n%O%n%A%n%C%n%S %Z', center: [13.756, 100.501], adminLabel: ['Province', '府'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('thai-post', 'Thailand Post Address Data', 'https://www.thailandpost.co.th/', 'address', 'provider-managed')],
    cities: [['Bangkok', '曼谷', 'กรุงเทพมหานคร'], ['Chiang Mai', '清迈', 'เชียงใหม่'], ['Phuket', '普吉', 'ภูเก็ต'], ['Pattaya', '芭堤雅', 'พัทยา'], ['Khon Kaen', '孔敬', 'ขอนแก่น'], ['Hat Yai', '合艾', 'หาดใหญ่']],
    admins: [['Bangkok', '曼谷', 'กรุงเทพมหานคร'], ['Chiang Mai', '清迈府', 'เชียงใหม่'], ['Phuket', '普吉府', 'ภูเก็ต'], ['Chon Buri', '春武里府', 'ชลบุรี'], ['Khon Kaen', '孔敬府', 'ขอนแก่น']]
  }),
  makeCountry({
    code: 'PH', en: 'Philippines', zh: '菲律宾', nativeName: 'Pilipinas', nativeLanguage: 'fil', flag: '🇵🇭', callingCode: '+63',
    group: 'southeast-asia', order: 19, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%Z %S', center: [14.5995, 120.9842], adminLabel: ['Province', '省'], postcodeLabel: ['ZIP code', '邮编'],
    primary: [source('psgc', 'Philippine Standard Geographic Code', 'https://psa.gov.ph/classification/psgc', 'admin', 'version-triggered')],
    cities: [['Manila', '马尼拉', 'Manila'], ['Quezon City', '奎松市', 'Quezon City'], ['Cebu City', '宿务市', 'Cebu City'], ['Davao City', '达沃市', 'Davao City'], ['Makati', '马卡蒂', 'Makati'], ['Pasig', '帕西格', 'Pasig']],
    admins: [['Metro Manila', '马尼拉大都会', 'Metro Manila'], ['Cebu', '宿务省', 'Cebu'], ['Davao del Sur', '南达沃省', 'Davao del Sur'], ['Cavite', '甲米地省', 'Cavite'], ['Laguna', '内湖省', 'Laguna']]
  }),
  makeCountry({
    code: 'VN', en: 'Vietnam', zh: '越南', nativeName: 'Việt Nam', nativeLanguage: 'vi', flag: '🇻🇳', callingCode: '+84',
    group: 'southeast-asia', order: 17, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%S %Z', latinFormat: '%N%n%O%n%A%n%C%n%S %Z', center: [10.823, 106.629], adminLabel: ['Province-level region', '省级行政区'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('vnpost', 'Vietnam Post Address Data', 'https://vnpost.vn/', 'address', 'provider-managed')],
    cities: [['Ho Chi Minh City', '胡志明市', 'Thành phố Hồ Chí Minh'], ['Hanoi', '河内', 'Hà Nội'], ['Da Nang', '岘港', 'Đà Nẵng'], ['Hai Phong', '海防', 'Hải Phòng'], ['Can Tho', '芹苴', 'Cần Thơ'], ['Hue', '顺化', 'Huế']],
    admins: [['Ho Chi Minh City', '胡志明市', 'Hồ Chí Minh'], ['Hanoi', '河内市', 'Hà Nội'], ['Da Nang', '岘港市', 'Đà Nẵng'], ['Hai Phong', '海防市', 'Hải Phòng'], ['Can Tho', '芹苴市', 'Cần Thơ']]
  }),

  makeCountry({
    code: 'TR', en: 'Türkiye', zh: '土耳其', nativeName: 'Türkiye', nativeLanguage: 'tr', flag: '🇹🇷', callingCode: '+90',
    group: 'middle-east', order: 23, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%Z %C/%S', center: [41.008, 28.978], adminLabel: ['Province', '省'], postcodeLabel: ['Posta kodu', '邮编'],
    primary: [source('uavt', 'National Address Database / MAKS', 'https://adres.nvi.gov.tr/', 'address', 'provider-managed')],
    cities: [['Istanbul', '伊斯坦布尔', 'İstanbul'], ['Ankara', '安卡拉', 'Ankara'], ['İzmir', '伊兹密尔', 'İzmir'], ['Bursa', '布尔萨', 'Bursa'], ['Antalya', '安塔利亚', 'Antalya'], ['Adana', '阿达纳', 'Adana']],
    admins: [['Istanbul', '伊斯坦布尔省', 'İstanbul'], ['Ankara', '安卡拉省', 'Ankara'], ['İzmir', '伊兹密尔省', 'İzmir'], ['Bursa', '布尔萨省', 'Bursa'], ['Antalya', '安塔利亚省', 'Antalya']]
  }),
  makeCountry({
    code: 'SA', en: 'Saudi Arabia', zh: '沙特阿拉伯', nativeName: 'المملكة العربية السعودية', nativeLanguage: 'ar', flag: '🇸🇦', callingCode: '+966',
    group: 'middle-east', order: 24, readiness: 'research', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%Z%n%C', latinFormat: '%N%n%O%n%A%n%Z%n%C', center: [24.7136, 46.6753], adminLabel: ['Province', '省'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('spl', 'SPL National Address', 'https://portal.splonline.com.sa/en/national-address', 'address', 'live')],
    cities: [['Riyadh', '利雅得', 'Riyadh'], ['Jeddah', '吉达', 'Jeddah'], ['Dammam', '达曼', 'Dammam'], ['Mecca', '麦加', 'Makkah'], ['Medina', '麦地那', 'Madinah'], ['Khobar', '胡拜尔', 'Al Khobar']],
    admins: [['Riyadh Province', '利雅得省', 'Riyadh Province'], ['Makkah Province', '麦加省', 'Makkah Province'], ['Eastern Province', '东部省', 'Eastern Province'], ['Madinah Province', '麦地那省', 'Madinah Province']]
  }),

  makeCountry({
    code: 'IN', en: 'India', zh: '印度', nativeName: 'India', nativeLanguage: 'en', flag: '🇮🇳', callingCode: '+91',
    group: 'south-asia', order: 21, readiness: 'partial', residential: true, googleValidation: true, googleResidential: true,
    format: '%N%n%O%n%A%n%C %Z%n%S', center: [12.9716, 77.5946], adminLabel: ['State', '邦'], postcodeLabel: ['PIN code', '邮编'],
    primary: [source('digipin', 'India Post DIGIPIN / PIN Directory', 'https://www.indiapost.gov.in/', 'address', 'release-triggered')],
    cities: [['Bengaluru', '班加罗尔', 'Bengaluru'], ['Mumbai', '孟买', 'Mumbai'], ['Delhi', '德里', 'Delhi'], ['Hyderabad', '海得拉巴', 'Hyderabad'], ['Chennai', '金奈', 'Chennai'], ['Kolkata', '加尔各答', 'Kolkata'], ['Pune', '浦那', 'Pune'], ['Ahmedabad', '艾哈迈达巴德', 'Ahmedabad'], ['Jaipur', '斋浦尔', 'Jaipur'], ['Surat', '苏拉特', 'Surat']],
    admins: [['Karnataka', '卡纳塔克邦', 'Karnataka'], ['Maharashtra', '马哈拉施特拉邦', 'Maharashtra'], ['Delhi', '德里', 'Delhi'], ['Tamil Nadu', '泰米尔纳德邦', 'Tamil Nadu'], ['Telangana', '特伦甘纳邦', 'Telangana'], ['West Bengal', '西孟加拉邦', 'West Bengal'], ['Gujarat', '古吉拉特邦', 'Gujarat'], ['Rajasthan', '拉贾斯坦邦', 'Rajasthan']]
  }),
  makeCountry({
    code: 'AU', en: 'Australia', zh: '澳大利亚', nativeName: 'Australia', nativeLanguage: 'en', flag: '🇦🇺', callingCode: '+61',
    group: 'oceania', order: 22, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%C %S %Z', center: [-33.8688, 151.2093], adminLabel: ['State', '州'], postcodeLabel: ['Postcode', '邮编'],
    primary: [source('gnaf', 'G-NAF', 'https://data.gov.au/data/dataset/geocoded-national-address-file-g-naf', 'address', 'quarterly')],
    cities: [['Sydney', '悉尼', 'Sydney'], ['Melbourne', '墨尔本', 'Melbourne'], ['Brisbane', '布里斯班', 'Brisbane'], ['Perth', '珀斯', 'Perth'], ['Adelaide', '阿德莱德', 'Adelaide'], ['Canberra', '堪培拉', 'Canberra'], ['Gold Coast', '黄金海岸', 'Gold Coast'], ['Hobart', '霍巴特', 'Hobart']],
    admins: [['New South Wales', '新南威尔士州', 'NSW'], ['Victoria', '维多利亚州', 'VIC'], ['Queensland', '昆士兰州', 'QLD'], ['Western Australia', '西澳大利亚州', 'WA'], ['South Australia', '南澳大利亚州', 'SA'], ['Australian Capital Territory', '澳大利亚首都领地', 'ACT']]
  }),

  makeCountry({
    code: 'BR', en: 'Brazil', zh: '巴西', nativeName: 'Brasil', nativeLanguage: 'pt-BR', flag: '🇧🇷', callingCode: '+55',
    group: 'south-america', order: 25, readiness: 'strict', residential: true, googleValidation: true, googleResidential: true,
    format: '%O%n%N%n%A%n%C-%S%n%Z', center: [-23.55, -46.633], adminLabel: ['State', '州'], postcodeLabel: ['CEP', '邮编'],
    primary: [source('cnefe', 'IBGE CNEFE', 'https://www.ibge.gov.br/estatisticas/sociais/populacao/38734-cadastro-nacional-de-enderecos-para-fins-estatisticos.html', 'residential', 'release-triggered')],
    cities: [['São Paulo', '圣保罗', 'São Paulo'], ['Rio de Janeiro', '里约热内卢', 'Rio de Janeiro'], ['Brasília', '巴西利亚', 'Brasília'], ['Salvador', '萨尔瓦多', 'Salvador'], ['Fortaleza', '福塔莱萨', 'Fortaleza'], ['Belo Horizonte', '贝洛奥里藏特', 'Belo Horizonte'], ['Curitiba', '库里蒂巴', 'Curitiba'], ['Recife', '累西腓', 'Recife']],
    admins: [['São Paulo', '圣保罗州', 'São Paulo'], ['Rio de Janeiro', '里约热内卢州', 'Rio de Janeiro'], ['Minas Gerais', '米纳斯吉拉斯州', 'Minas Gerais'], ['Bahia', '巴伊亚州', 'Bahia'], ['Paraná', '巴拉那州', 'Paraná'], ['Federal District', '联邦区', 'Distrito Federal']]
  }),
  makeCountry({
    code: 'NG', en: 'Nigeria', zh: '尼日利亚', nativeName: 'Nigeria', nativeLanguage: 'en', flag: '🇳🇬', callingCode: '+234',
    group: 'africa', order: 26, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C %Z%n%S', center: [6.5244, 3.3792], adminLabel: ['State', '州'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('grid3', 'GRID3 Nigeria', 'https://grid3.org/', 'building', 'version-triggered')],
    cities: [['Lagos', '拉各斯', 'Lagos'], ['Abuja', '阿布贾', 'Abuja'], ['Port Harcourt', '哈科特港', 'Port Harcourt'], ['Kano', '卡诺', 'Kano'], ['Ibadan', '伊巴丹', 'Ibadan'], ['Benin City', '贝宁城', 'Benin City']],
    admins: [['Lagos', '拉各斯州', 'Lagos'], ['Federal Capital Territory', '联邦首都区', 'Federal Capital Territory'], ['Rivers', '河流州', 'Rivers'], ['Kano', '卡诺州', 'Kano']]
  }),
  makeCountry({
    code: 'ZA', en: 'South Africa', zh: '南非', nativeName: 'South Africa', nativeLanguage: 'en', flag: '🇿🇦', callingCode: '+27',
    group: 'africa', order: 27, readiness: 'partial', residential: true, googleValidation: false, googleResidential: false,
    format: '%N%n%O%n%A%n%C%n%Z', center: [-33.9249, 18.4241], adminLabel: ['Province', '省'], postcodeLabel: ['Postal code', '邮编'],
    primary: [source('nad-za', 'South African National Address Database', 'https://www.csir.co.za/', 'address', 'version-triggered')],
    cities: [['Cape Town', '开普敦', 'Cape Town'], ['Johannesburg', '约翰内斯堡', 'Johannesburg'], ['Durban', '德班', 'Durban'], ['Pretoria', '比勒陀利亚', 'Pretoria'], ['Gqeberha', '格贝哈', 'Gqeberha'], ['Bloemfontein', '布隆方丹', 'Bloemfontein']],
    admins: [['Western Cape', '西开普省', 'Western Cape'], ['Gauteng', '豪登省', 'Gauteng'], ['KwaZulu-Natal', '夸祖鲁-纳塔尔省', 'KwaZulu-Natal'], ['Eastern Cape', '东开普省', 'Eastern Cape'], ['Free State', '自由邦省', 'Free State']]
  })
].sort((left, right) => left.order - right.order);

export const countryByCode = new Map<CountryCode, CountryConfig>(
  countries.map((country) => [country.code, country])
);

export const countryCodes = countries.map((country) => country.code);

export const isCountryCode = (value: string): value is CountryCode =>
  countryByCode.has(value as CountryCode);
