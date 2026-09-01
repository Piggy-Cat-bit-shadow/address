import type { Locale } from './types';

export type ApiMethod = 'GET' | 'POST';
export type ApiScope = 'public' | 'read' | 'generate';
export type ApiParameterLocation = 'path' | 'query' | 'body';

export interface ApiParameter {
  name: string;
  location: ApiParameterLocation;
  type: 'string' | 'boolean' | 'integer' | 'array' | 'object';
  required?: boolean;
  defaultValue?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  schema?: Record<string, unknown>;
  description: string;
  descriptionZh: string;
}

export interface PublicApiEndpoint {
  id: string;
  method: ApiMethod;
  path: string;
  scope: ApiScope;
  summary: Record<Locale, string>;
  parameters: readonly ApiParameter[];
  exampleQuery?: string;
  examplePath?: Record<string, string>;
  exampleBody?: Record<string, unknown>;
  successExample: Record<string, unknown>;
}

const localized = (
  en: string, zhCN: string, zhTW: string, ja: string, ko: string,
  de: string, fr: string, es: string, pt: string
): Record<Locale, string> => ({ en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, de, fr, es, pt });

const country: ApiParameter = {
  name: 'country', location: 'query', type: 'string', defaultValue: 'US',
  description: 'ISO 3166-1 alpha-2 country code.', descriptionZh: 'ISO 3166-1 alpha-2 国家或地区代码。'
};

export const publicApiEndpoints: readonly PublicApiEndpoint[] = [
  {
    id: 'health', method: 'GET', path: '/api/v1/health', scope: 'public', parameters: [],
    summary: localized(
      'Check whether the API process is available.', '检查 API 进程是否可用。', '檢查 API 程序是否可用。',
      'API プロセスが利用可能か確認します。', 'API 프로세스의 사용 가능 여부를 확인합니다.',
      'Prueft, ob der API-Prozess verfuegbar ist.', "Verifie que le processus d'API est disponible.",
      'Comprueba si el proceso de API esta disponible.', 'Verifica se o processo da API esta disponivel.'
    ),
    successExample: { status: 'ok' }
  },
  {
    id: 'ready', method: 'GET', path: '/api/v1/ready', scope: 'public', parameters: [],
    summary: localized(
      'Check whether the API and PostgreSQL are ready to serve traffic.', '检查 API 和 PostgreSQL 是否可以接收流量。',
      '檢查 API 和 PostgreSQL 是否可以接收流量。', 'API と PostgreSQL がリクエストを処理できるか確認します。',
      'API와 PostgreSQL이 트래픽을 처리할 준비가 되었는지 확인합니다.', 'Prueft die Einsatzbereitschaft von API und PostgreSQL.',
      "Verifie que l'API et PostgreSQL sont prets a servir le trafic.", 'Comprueba si la API y PostgreSQL estan listos para recibir trafico.',
      'Verifica se a API e o PostgreSQL estao prontos para receber trafego.'
    ),
    successExample: { status: 'ready' }
  },
  {
    id: 'countries', method: 'GET', path: '/api/v1/countries', scope: 'read', parameters: [],
    summary: localized(
      'List supported countries, capabilities, address counts, and shortcuts.', '列出支持的国家、能力、地址数量和快捷区域。',
      '列出支援的國家、能力、地址數量和快捷區域。', '対応国、機能、住所数、ショートカットを一覧表示します。',
      '지원 국가, 기능, 주소 수 및 바로가기를 조회합니다.', 'Listet Laender, Funktionen, Adresszahlen und Schnellzugriffe auf.',
      'Liste les pays, capacites, volumes et raccourcis.', 'Enumera paises, capacidades, cantidades y accesos directos.',
      'Lista paises, recursos, contagens e atalhos.'
    ),
    successExample: { data: [{ code: 'US', residentialAvailable: true, residentialCount: 50000, generationMode: 'synchronized-pool' }] }
  },
  {
    id: 'availability', method: 'GET', path: '/api/v1/availability', scope: 'read', parameters: [],
    summary: localized(
      'Return the lightweight residential availability list.', '返回轻量级住宅地址可用性列表。', '傳回輕量級住宅地址可用性清單。',
      '住宅住所の利用可能国を軽量な一覧で返します。', '주거 주소 가용 국가 목록을 간단히 반환합니다.',
      'Liefert die kompakte Liste verfuegbarer Wohnadressen.', 'Renvoie la liste legere de disponibilite residentielle.',
      'Devuelve la lista ligera de disponibilidad residencial.', 'Retorna a lista leve de disponibilidade residencial.'
    ),
    successExample: { data: [{ code: 'US', residentialAvailable: true }] }
  },
  {
    id: 'client-context', method: 'GET', path: '/api/v1/client-context', scope: 'read',
    summary: localized(
      'Resolve country and location context for the request IP.', '解析请求 IP 对应的国家和位置上下文。', '解析請求 IP 對應的國家和位置內容。',
      'リクエスト IP の国と位置情報を解決します。', '요청 IP의 국가 및 위치 컨텍스트를 확인합니다.',
      'Ermittelt Land und Standortkontext der Anfrage-IP.', "Resout le pays et le contexte geographique de l'adresse IP.",
      'Resuelve el pais y el contexto de ubicacion de la IP.', 'Resolve o pais e o contexto de localizacao do IP.'
    ),
    parameters: [{ name: 'ip', location: 'query', type: 'string', description: 'Optional IPv4 or IPv6 address; omitted means the request IP.', descriptionZh: '可选 IPv4 或 IPv6；省略时使用当前请求 IP。' }],
    exampleQuery: 'ip=198.51.100.7',
    successExample: { data: { country: 'US', region: 'California', city: 'Los Angeles', matchLevel: 'city' } }
  },
  {
    id: 'locations', method: 'GET', path: '/api/v1/locations/search', scope: 'read',
    summary: localized(
      'Search regions, cities, districts, or postcodes with pagination.', '分页搜索州省、城市、区县或邮编。',
      '分頁搜尋州省、城市、區縣或郵遞區號。', '地域、都市、地区、郵便番号をページング検索します。',
      '지역, 도시, 구역 또는 우편번호를 페이지 단위로 검색합니다.', 'Sucht Regionen, Staedte, Bezirke oder Postleitzahlen mit Seitennavigation.',
      'Recherche regions, villes, districts ou codes postaux avec pagination.', 'Busca regiones, ciudades, distritos o codigos postales con paginacion.',
      'Pesquisa regioes, cidades, distritos ou codigos postais com paginacao.'
    ),
    parameters: [
      country,
      { name: 'field', location: 'query', type: 'string', defaultValue: 'city', enum: ['region', 'city', 'district', 'postcode'], description: 'Catalog field to return.', descriptionZh: '要返回的目录字段。' },
      { name: 'q', location: 'query', type: 'string', description: 'Optional case-insensitive search text.', descriptionZh: '可选、不区分大小写的搜索文本。' },
      { name: 'region', location: 'query', type: 'string', description: 'Exact parent region value.', descriptionZh: '精确的上级行政区值。' },
      { name: 'regionId', location: 'query', type: 'string', description: 'Stable parent region ID.', descriptionZh: '稳定的上级行政区 ID。' },
      { name: 'cityId', location: 'query', type: 'string', description: 'Stable parent city ID.', descriptionZh: '稳定的上级城市 ID。' },
      { name: 'residential', location: 'query', type: 'boolean', defaultValue: 'false', description: 'Restrict counts to published residential records.', descriptionZh: '仅统计已发布的住宅记录。' },
      { name: 'cursor', location: 'query', type: 'string', description: 'Opaque cursor returned by the previous page.', descriptionZh: '上一页返回的不透明游标。' },
      { name: 'limit', location: 'query', type: 'integer', defaultValue: '100', minimum: 20, maximum: 200, description: 'Page size from 20 through 200.', descriptionZh: '每页 20 至 200 条。' }
    ],
    exampleQuery: 'country=US&field=city&regionId=1416&limit=100',
    successExample: { data: { cities: [{ id: 'example-city', value: 'Los Angeles', availableCount: 120 }], total: 1, nextCursor: null } }
  },
  {
    id: 'generate', method: 'GET', path: '/api/v1/generate', scope: 'generate',
    summary: localized(
      'Randomly generate one published residential address and test profile.', '随机生成一个已发布的真实住宅地址和测试资料。',
      '隨機產生一個已發布的真實住宅地址和測試資料。', '公開済み住宅住所とテストプロフィールをランダム生成します。',
      '게시된 주거 주소와 테스트 프로필을 무작위로 생성합니다.', 'Erzeugt zufaellig eine veroeffentlichte Wohnadresse mit Testprofil.',
      'Genere aleatoirement une adresse residentielle publiee et un profil de test.',
      'Genera aleatoriamente una direccion residencial publicada y un perfil de prueba.',
      'Gera aleatoriamente um endereco residencial publicado e um perfil de teste.'
    ),
    parameters: [
      country,
      { name: 'region', location: 'query', type: 'string', description: 'Exact first-level region value.', descriptionZh: '精确的一级行政区值。' },
      { name: 'regionId', location: 'query', type: 'string', description: 'Stable region ID from location search.', descriptionZh: '位置搜索返回的行政区 ID。' },
      { name: 'city', location: 'query', type: 'string', description: 'Exact city value.', descriptionZh: '精确城市值。' },
      { name: 'cityId', location: 'query', type: 'string', description: 'Stable city ID from location search.', descriptionZh: '位置搜索返回的城市 ID。' },
      { name: 'district', location: 'query', type: 'string', description: 'Exact district value where supported.', descriptionZh: '支持国家的精确区县值。' },
      { name: 'districtId', location: 'query', type: 'string', description: 'Stable district ID from location search.', descriptionZh: '位置搜索返回的稳定区县 ID。' },
      { name: 'postcode', location: 'query', type: 'string', description: 'Exact postcode value.', descriptionZh: '精确邮编值。' },
      { name: 'postcodeId', location: 'query', type: 'string', description: 'Stable postcode ID from location search.', descriptionZh: '位置搜索返回的邮编 ID。' },
      { name: 'mode', location: 'query', type: 'string', enum: ['ip-region'], description: 'Use ip-region to match the request or supplied IP.', descriptionZh: '使用 ip-region 按请求或指定 IP 匹配。' },
      { name: 'ip', location: 'query', type: 'string', description: 'IPv4 or IPv6 used with ip-region mode.', descriptionZh: 'ip-region 模式使用的 IPv4 或 IPv6。' },
      { name: 'q', location: 'query', type: 'string', description: 'Text that must occur in the selected address components.', descriptionZh: '必须出现在所选地址字段中的文本。' },
      { name: 'strategy', location: 'query', type: 'string', defaultValue: 'random', enum: ['random', 'instant'], description: 'Selection strategy; both modes select from the synchronized database.', descriptionZh: '选择策略；两种模式都从已同步数据库选择。' },
      { name: 'residential', location: 'query', type: 'boolean', defaultValue: 'true', description: 'Legacy compatibility flag; generation always returns residential records.', descriptionZh: '兼容旧客户端的参数；生成接口始终返回住宅记录。' },
      { name: 'seed', location: 'query', type: 'string', description: 'Optional reproducible random seed.', descriptionZh: '可选的可复现随机种子。' },
      { name: 'requestId', location: 'query', type: 'string', description: 'Caller-provided request correlation ID.', descriptionZh: '调用方提供的请求关联 ID。' }
    ],
    exampleQuery: 'country=US&region=California&requestId=YOUR_REQUEST_ID',
    successExample: { data: { requestId: 'YOUR_REQUEST_ID', country: 'US', mode: 'residential', sourcesTried: ['address-pool-v2'], result: { address: { id: 'address-id', countryCode: 'US', formattedAddress: 'Example address' } } } }
  },
  {
    id: 'generate-batch', method: 'POST', path: '/api/v1/generate/batch', scope: 'generate',
    summary: localized(
      'Generate up to 50 residential addresses with structured filters, exclusions, and uniqueness control.', '使用结构化筛选、排除条件和唯一性控制批量生成最多 50 个住宅地址。',
      '使用結構化篩選、排除條件和唯一性控制批量產生最多 50 個住宅地址。', '構造化フィルター、除外条件、一意性制御で最大 50 件の住宅住所を生成します。',
      '구조화 필터, 제외 조건 및 고유성 제어로 최대 50개의 주거 주소를 생성합니다.', 'Erzeugt bis zu 50 Wohnadressen mit strukturierten Filtern, Ausschluessen und Eindeutigkeit.',
      "Genere jusqu'a 50 adresses residentielles avec filtres structures, exclusions et unicite.", 'Genera hasta 50 direcciones residenciales con filtros, exclusiones y unicidad.',
      'Gera ate 50 enderecos residenciais com filtros estruturados, exclusoes e unicidade.'
    ),
    parameters: [
      { name: 'count', location: 'body', type: 'integer', required: true, minimum: 1, maximum: 50, description: 'Number of addresses to generate.', descriptionZh: '要生成的地址数量。' },
      { name: 'filters', location: 'body', type: 'object', required: true, schema: {
        type: 'object', required: ['country'], additionalProperties: false,
        properties: Object.fromEntries(['country', 'region', 'regionId', 'city', 'cityId', 'district', 'districtId', 'postcode', 'postcodeId', 'q']
          .map((name) => [name, { type: 'string' }]))
      }, description: 'Country and exact administrative, postcode, or text filters.', descriptionZh: '国家以及精确行政区、邮编或文本筛选条件。' },
      { name: 'options', location: 'body', type: 'object', schema: {
        type: 'object', additionalProperties: false, properties: {
          unique: { type: 'boolean', default: true }, seed: { type: 'string' },
          strategy: { type: 'string', enum: ['random', 'instant'], default: 'random' }, requestId: { type: 'string' }
        }
      }, description: 'Randomness, uniqueness, strategy, and request correlation options.', descriptionZh: '随机性、唯一性、策略和请求关联选项。' },
      { name: 'excludeAddressIds', location: 'body', type: 'array', schema: { type: 'array', maxItems: 500, items: { type: 'string' } }, description: 'Address IDs that must not be returned.', descriptionZh: '不得返回的地址 ID 列表。' }
    ],
    exampleBody: { count: 3, filters: { country: 'US', region: 'California', city: 'Los Angeles' }, options: { unique: true, strategy: 'random', seed: 'example-seed' }, excludeAddressIds: [] },
    successExample: { data: { requestId: 'batch-request-id', requestedCount: 3, returnedCount: 3, unique: true, results: [{ address: { id: 'address-id', countryCode: 'US' } }] } }
  },
  {
    id: 'location-hierarchy', method: 'GET', path: '/api/v1/locations/hierarchy', scope: 'read',
    summary: localized(
      'List the immediate administrative or postcode children of a country, region, or city.', '列出国家、省州或城市的下一级行政区或邮编。',
      '列出國家、省州或城市的下一級行政區或郵遞區號。', '国、地域、都市の直下にある行政区または郵便番号を一覧表示します。',
      '국가, 지역 또는 도시의 바로 아래 행정 구역이나 우편번호를 조회합니다.', 'Listet direkte Verwaltungs- oder Postleitzahlkinder eines Landes, einer Region oder Stadt.',
      "Liste les subdivisions administratives ou codes postaux directs d'un pays, d'une region ou d'une ville.", 'Enumera las divisiones administrativas o codigos postales hijos de un pais, region o ciudad.',
      'Lista subdivisoes administrativas ou codigos postais filhos de um pais, regiao ou cidade.'
    ),
    parameters: [
      { ...country, required: true, defaultValue: undefined },
      { name: 'childType', location: 'query', type: 'string', required: true, enum: ['region', 'city', 'district', 'postcode'], description: 'Child catalog type to return.', descriptionZh: '要返回的下级目录类型。' },
      { name: 'parentType', location: 'query', type: 'string', defaultValue: 'country', enum: ['country', 'region', 'city'], description: 'Type of parent identified by parentId.', descriptionZh: 'parentId 指定的上级类型。' },
      { name: 'parentId', location: 'query', type: 'string', description: 'Stable region or city ID; omit for a country parent.', descriptionZh: '稳定的省州或城市 ID；国家上级时省略。' },
      { name: 'q', location: 'query', type: 'string', description: 'Optional child-name search text.', descriptionZh: '可选的下级名称搜索文本。' },
      { name: 'residential', location: 'query', type: 'boolean', defaultValue: 'true', description: 'Include residential availability and disable uncovered options.', descriptionZh: '包含住宅可用数量并禁用无覆盖选项。' },
      { name: 'cursor', location: 'query', type: 'string', description: 'Opaque cursor returned by the previous page.', descriptionZh: '上一页返回的不透明游标。' },
      { name: 'limit', location: 'query', type: 'integer', defaultValue: '100', minimum: 20, maximum: 200, description: 'Page size from 20 through 200.', descriptionZh: '每页 20 至 200 条。' }
    ],
    exampleQuery: 'country=US&parentType=region&parentId=1416&childType=city&limit=100',
    successExample: { data: { parent: { type: 'region', id: '1416' }, childType: 'city', children: [{ id: 'example-city', value: 'Los Angeles', availableCount: 120 }], total: 1, nextCursor: null } }
  },
  {
    id: 'coverage', method: 'GET', path: '/api/v1/coverage', scope: 'read',
    summary: localized(
      'Report the three synchronization completion rules for enabled countries.', '返回已启用国家的三项同步完成规则。', '傳回已啟用國家的三項同步完成規則。',
      '有効な国の 3 つの同期完了ルールを返します。', '활성화된 국가의 세 가지 동기화 완료 규칙을 반환합니다.',
      'Meldet die drei Abschlussregeln der Synchronisierung fuer aktivierte Laender.', 'Indique les trois regles de completion de synchronisation pour les pays actifs.',
      'Informa las tres reglas de finalizacion de sincronizacion para los paises activos.', 'Relata as tres regras de conclusao da sincronizacao para os paises ativos.'
    ),
    parameters: [
      { name: 'country', location: 'query', type: 'string', description: 'Optional ISO country code filter.', descriptionZh: '可选的 ISO 国家代码筛选。' },
      { name: 'includeComplete', location: 'query', type: 'boolean', defaultValue: 'true', description: 'Include countries that already satisfy all three rules.', descriptionZh: '是否包含已经满足全部三项规则的国家。' }
    ],
    exampleQuery: 'country=US&includeComplete=true',
    successExample: { data: { countries: [{ countryCode: 'US', complete: false, rules: { total: { current: 42000, target: 50000, met: false }, administrativeCoverage: { actual: 0.98, target: 1, met: false }, regionalMinimums: { actual: 0.95, target: 1, met: false } } }] } }
  },
  {
    id: 'address', method: 'GET', path: '/api/v1/addresses/{id}', scope: 'read',
    summary: localized(
      'Retrieve a currently published synchronized address by its generated ID.', '通过生成结果中的 ID 查询当前仍在发布的同步地址。', '透過產生結果中的 ID 查詢目前仍在發布的同步地址。',
      '生成結果の ID で現在公開中の同期済み住所を取得します。', '생성 결과의 ID로 현재 게시 중인 동기화 주소를 조회합니다.',
      'Ruft eine aktuell veroeffentlichte synchronisierte Adresse anhand ihrer ID ab.', 'Recupere une adresse synchronisee actuellement publiee par son identifiant.',
      'Recupera una direccion sincronizada publicada actualmente mediante su ID.', 'Recupera um endereco sincronizado atualmente publicado pelo ID.'
    ),
    parameters: [{ name: 'id', location: 'path', type: 'string', required: true, description: 'Address ID returned by generate or batch generation.', descriptionZh: '生成或批量生成接口返回的地址 ID。' }],
    examplePath: { id: 'pool-v2-address-id' },
    successExample: { data: { address: { id: 'pool-v2-address-id', countryCode: 'US', formattedAddress: 'Example address' } } }
  },
  {
    id: 'translation', method: 'POST', path: '/api/v1/address-translation', scope: 'generate',
    summary: localized(
      'Translate a synchronized address into a supported display language.', '将已同步地址翻译为支持的显示语言。',
      '將已同步地址翻譯為支援的顯示語言。', '同期済み住所を対応表示言語へ翻訳します。',
      '동기화된 주소를 지원되는 표시 언어로 번역합니다.', 'Uebersetzt eine synchronisierte Adresse in eine unterstuetzte Anzeigesprache.',
      'Traduit une adresse synchronisee vers une langue prise en charge.', 'Traduce una direccion sincronizada a un idioma compatible.',
      'Traduz um endereco sincronizado para um idioma compativel.'
    ),
    parameters: [
      { name: 'addressId', location: 'body', type: 'string', required: true, description: 'Address ID returned by generate.', descriptionZh: 'generate 返回的地址 ID。' },
      { name: 'targetLocale', location: 'body', type: 'string', required: true, enum: ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt'], description: 'Target display locale.', descriptionZh: '目标显示语言。' }
    ],
    exampleBody: { addressId: 'address-id', targetLocale: 'zh-CN' },
    successExample: { data: { components: { street: '示例街道', houseNumber: '20' }, lines: ['示例地址'], singleLine: '示例地址' } }
  },
  {
    id: 'data-health', method: 'GET', path: '/api/v1/data-health', scope: 'read', parameters: [],
    summary: localized(
      'Report per-country synchronized-pool health and configuration errors.', '报告各国家同步地址池健康状态和配置错误。',
      '報告各國同步地址池健康狀態和設定錯誤。', '国別の同期プール状態と設定エラーを報告します。',
      '국가별 동기화 풀 상태와 구성 오류를 보고합니다.', 'Meldet den Zustand der synchronisierten Laenderpools und Konfigurationsfehler.',
      'Indique la sante des pools synchronises et les erreurs de configuration.',
      'Informa del estado de los pools sincronizados y errores de configuracion.',
      'Relata a saude dos pools sincronizados e erros de configuracao.'
    ),
    successExample: { data: { healthy: true, countries: [{ code: 'US', ready: true, count: 50000 }], configurationErrors: [] } }
  }
] as const;

export const apiExample = (endpoint: PublicApiEndpoint, language: 'curl' | 'python' | 'javascript'): string => {
  const query = endpoint.exampleQuery ? `?${endpoint.exampleQuery}` : '';
  const path = Object.entries(endpoint.examplePath || {}).reduce((value, [name, replacement]) => value.replace(`{${name}}`, replacement), endpoint.path);
  const url = `https://address.example${path}${query}`;
  const auth = endpoint.scope === 'public' ? {} : { Authorization: 'Bearer YOUR_API_TOKEN' };
  const headers = endpoint.method === 'POST' ? { ...auth, 'Content-Type': 'application/json' } : auth;
  const body = endpoint.exampleBody ? JSON.stringify(endpoint.exampleBody, null, 2) : undefined;
  if (language === 'curl') {
    const headerLines = Object.entries(headers).map(([name, value]) => `  -H "${name}: ${value}" \\\n`).join('');
    return [`curl ${endpoint.method === 'POST' ? '-X POST ' : ''}"${url}" \\`, headerLines.trimEnd(), body ? `  --data '${body}'` : ''].filter(Boolean).join('\n');
  }
  if (language === 'python') {
    const options = [headers && Object.keys(headers).length ? `headers=${JSON.stringify(headers)}` : '', body ? `data=json.dumps(${JSON.stringify(endpoint.exampleBody)})` : '', `method="${endpoint.method}"`].filter(Boolean).join(',\n    ');
    return `import json\nfrom urllib.request import Request, urlopen\n\nrequest = Request(\n    "${url}",\n    ${options}\n)\nwith urlopen(request) as response:\n    print(json.load(response))`;
  }
  const init = endpoint.method === 'GET' && !Object.keys(headers).length ? '' : `, {\n  method: "${endpoint.method}",${Object.keys(headers).length ? `\n  headers: ${JSON.stringify(headers, null, 2).replaceAll('\n', '\n  ')},` : ''}${body ? `\n  body: JSON.stringify(${JSON.stringify(endpoint.exampleBody, null, 2).replaceAll('\n', '\n  ')})` : ''}\n}`;
  return `const response = await fetch("${url}"${init});\nconst payload = await response.json();\nconsole.log(payload);`;
};

const schemaFor = (parameter: ApiParameter) => parameter.schema || ({
  type: parameter.type,
  ...(parameter.enum ? { enum: parameter.enum } : {}),
  ...(parameter.defaultValue !== undefined ? { default: parameter.type === 'integer' ? Number(parameter.defaultValue) : parameter.type === 'boolean' ? parameter.defaultValue === 'true' : parameter.defaultValue } : {}),
  ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
  ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum })
});

export const publicOpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Real Residential Address Generator API', version: '1.0.0' },
  servers: [{ url: 'https://address.example' }],
  paths: Object.fromEntries(publicApiEndpoints.map((endpoint) => [endpoint.path, {
    [endpoint.method.toLowerCase()]: {
      operationId: endpoint.id,
      summary: endpoint.summary.en,
      security: endpoint.scope === 'public' ? [] : [{ bearerAuth: [] }],
      parameters: endpoint.parameters.filter((parameter) => parameter.location !== 'body').map((parameter) => ({
        name: parameter.name, in: parameter.location, required: parameter.location === 'path' || Boolean(parameter.required), description: parameter.description, schema: schemaFor(parameter)
      })),
      ...(endpoint.parameters.some((parameter) => parameter.location === 'body') ? {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: endpoint.parameters.filter((parameter) => parameter.location === 'body' && parameter.required).map((parameter) => parameter.name),
            properties: Object.fromEntries(endpoint.parameters.filter((parameter) => parameter.location === 'body').map((parameter) => [parameter.name, schemaFor(parameter)]))
          }, example: endpoint.exampleBody } }
        }
      } : {}),
      responses: {
        '200': { description: 'Successful response', content: { 'application/json': { example: endpoint.successExample } } },
        ...(endpoint.scope === 'public' ? {} : {
          '401': { description: 'Missing, expired, or invalid bearer token.' },
          '429': { description: 'Rate limit exceeded. Retry-After is returned in seconds.' }
        })
      }
    }
  }])),
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }
} as const;
