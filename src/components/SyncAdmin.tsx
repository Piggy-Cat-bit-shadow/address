import { useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { countryByCode, isCountryCode } from '../domain/countries';

type View = 'dashboard' | 'policies' | 'access' | 'providers' | 'china' | 'tokens' | 'runs';
type AdminLocale = 'zh-CN' | 'en';
interface Credential {
  id: string; provider: string; label: string; mask: string; enabled: boolean; status: string; expiresAt?: string;
  quotaService: string; quotaPeriod: 'day' | 'month'; quotaUsed: number; quotaLimit: number; quotaRemaining: number;
  quotaResetAt: string; quotaUsageSource: 'provider' | 'local'; providerReportedAt?: string | null; lastSuccessAt?: string;
}
interface CoverageNode { key: string; countryCode: string; level: number; levelLabel: string; regionCode: string; regionName: string; ordinaryCount: number; residentialCount: number; totalCount: number; childCount: number; updatedAt: string }
interface AmapBrowserStatus { configured: boolean; enabled: boolean; label: string; mask: string; securityMask: string; status: string; lastUsedAt: string | null; updatedAt: string | null }
interface MapSettings { google: { china: boolean; international: boolean }; amap: { china: boolean; international: boolean }; amapBrowser: AmapBrowserStatus }
interface ProviderViewData { credentials: Credential[]; maps: MapSettings }
interface ApiTokenView { id: string; name: string; scopes: string[]; rate_limit_per_minute: number; expires_at: string | null; revoked_at: string | null; token_mask: string; token_revealable: boolean }
type Mutate = <T = unknown>(path: string, method: string, body?: unknown, success?: string) => Promise<T | undefined>;
type Reveal = (path: string) => Promise<Record<string, string>>;
type RequestData = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
interface CountryPolicy { countryCode: string; enabled: boolean; targetCount: number; level1Limit: number; level2Limit: number; level3Limit: number; level4Limit: number; currentCount: number; deficit: number; excess: number; state: string; sourceVersion: string | null; labels: string[] }
interface PolicyNode { key: string; parentKey: string; countryCode: string; level: number; regionName: string; currentCount: number; childCount: number; inheritedTarget: number; overrideTarget: number | null; targetCount: number; deficit: number; excess: number }
interface PolicyViewData { runtime: { prepareConcurrency: number; cpuConcurrency: number }; countries: CountryPolicy[] }

const adminText = {
  'zh-CN': {
    labels: { dashboard: '仪表盘', policies: '同步策略', providers: '地图密钥', china: '中国同步', access: '访问与安全', tokens: '接口令牌', runs: '任务中心' },
    providers: { amap: '高德', baidu: '百度', tencent: '腾讯', onemap: '新加坡地图' },
    brandName: '地址', brand: '管理系统', loginTitle: '管理员登录', password: '管理员密码', login: '登录', loggingIn: '登录中…', backGenerator: '返回生成器',
    bootstrap: '请先在服务器配置管理员初始密码并重启服务。', loading: '正在加载…', logout: '退出登录', language: '英文',
    dashboardTitle: '地址数据', dashboardDescription: '按国家和行政层级查看已收录地址。', allCountries: '全部国家', region: '区域', level: '行政层级', available: '可用地址', residential: '真实住宅', ordinary: '普通地址', children: '下级区域', updated: '更新时间', noSubregions: '暂无下级数据', noAddressData: '暂无地址数据', emptyDashboard: '当前数据库没有地址记录。导入或同步数据后，可继续下钻查看国家、省市和区县。',
    policiesTitle: '地址数量与并发', policiesDescription: '按国家和行政节点控制最新真实地址快照的数量。', prepareConcurrency: '并行准备国家数', cpuConcurrency: '重型解析并发数', countryTarget: '国家目标', actualCount: '当前数量', difference: '差额', sourceVersion: '数据版本', hierarchyLimits: '层级上限', editPolicy: '修改策略', browseNodes: '管理区域', saveRuntime: '保存并发设置', runtimeSaved: '并发设置已保存', policySaved: '同步策略已保存', nodeOverride: '区域目标', inheritedTarget: '默认上限', customTarget: '自定义目标', useInherited: '恢复默认', noPolicyNodes: '当前层级暂无行政节点。', policyHint: '目标只裁剪地址记录；行政区划和邮编目录保持完整。候选不足时显示缺口，不生成地址。', deficit: '缺少', excess: '超出', ready: '已达目标', backCountries: '返回国家', enabled: '参与自动同步', unlimitedLevel: '0 表示该层级不单独限制', manage: '管理',
    accessTitle: '访问策略', accessDescription: '先设置访问方式，再保存密码和接口保护规则。', frontendPasswordEnabled: '启用前端访问密码', apiAuthEnabled: '外部接口强制使用访问令牌', newFrontendPassword: '新前端密码', confirmFrontendPassword: '重复前端密码', newAdminPassword: '新管理员密码', confirmAdminPassword: '重复管理员密码', passwordSection: '密码设置', policySection: '访问控制', keepUnchanged: '留空则保持不变', saveSettings: '保存设置', settingsSaved: '访问设置已保存', passwordMismatch: '两次输入的密码不一致。', changeFrontendPassword: '修改前端密码', changeAdminPassword: '修改管理员密码', passwordDialogHint: '请输入新密码并再次确认；保存后输入内容会被清空。', passwordNew: '新密码', passwordConfirm: '重复确认', showPassword: '显示', hidePassword: '隐藏', savePassword: '保存密码',
    providersTitle: '地图密钥', providersDescription: '管理地图平台凭据；密钥默认隐藏，仅按需显示。', addKey: '添加密钥', addMapKey: '添加地图密钥', provider: '平台', optionalName: '名称（可选）', autoName: '留空自动命名', key: '密钥', cancel: '取消', save: '保存', keySaved: '地图密钥已保存', stop: '停用', enable: '启用', test: '测试', testSuccess: '密钥测试成功', remove: '删除', noKeys: '尚未添加地图密钥', quotaUsage: '额度', quotaDay: '每日', quotaMonth: '每月', quotaProvider: '平台实时', quotaLocal: '本地统计', quotaReset: '重置', quotaRemaining: '剩余', lastSuccess: '最近成功',
    mapDisplayTitle: '前端地图显示', mapChina: '中国地址', mapInternational: '国外地址', googleMap: '谷歌地图', amapMap: '高德地图', mapDisplaySaved: '地图显示设置已保存', mapDisplayHint: '关闭的平台不会在前端加载脚本、框架或发起地图请求。',
    amapBrowserTitle: '高德地图浏览器密钥', configureAmapBrowser: '配置密钥', editAmapBrowser: '修改密钥', amapBrowserDialog: '配置高德地图浏览器密钥', amapBrowserLabel: '密钥名称', amapBrowserPlaceholder: '高德浏览器地图', amapApiKey: '浏览器接口密钥', amapSecurityCode: '安全密钥', amapBrowserSaved: '高德地图浏览器密钥已保存', amapBrowserRemoved: '高德地图浏览器密钥已删除', amapBrowserEmpty: '尚未配置高德地图浏览器密钥', amapBrowserSecurity: '浏览器只会收到受域名白名单约束的专用接口密钥；安全密钥和服务端同步密钥始终保留在服务端。', replaceSecret: '留空则保留当前值', amapUpdated: '更新时间', amapLastUsed: '最近使用', confirmRemoveAmap: '确定删除高德地图浏览器密钥吗？',
    chinaTitle: '中国同步', chinaDescription: '配置真实小区同步，查看平台配额和覆盖进度。', chinaTotal: '真实小区', cities: '覆盖城市', districts: '已覆盖区县', focusCities: '已覆盖重点城市', crossVerified: '跨平台验证', availableKeys: '可用密钥', estimate: '基础覆盖预计', waitingKeys: '等待可用密钥', minutes: '约 {value} 分钟', autoSync: '自动同步', syncNow: '开始/继续同步', syncing: '同步中', areaFallback: '行政区划数据待导入，当前先覆盖重点城市；导入后自动切换全国区县。', areaReady: '系统优先为每个区县补齐 10 个真实小区，完成基础覆盖后自动继续丰富数据。', pendingCommunities: '{value} 个基础小区待补齐', focusCoverage: '重点城市覆盖', districtCoverage: '区县覆盖', province: '省级', city: '城市', district: '区县', currentCommunities: '当前小区', target: '基础目标', covered: '已覆盖', pending: '待补齐', noAreas: '行政区划数据待初始化', platformData: '平台数据量', syncSubmitted: '同步任务已提交',
    tokensTitle: '接口令牌', tokensDescription: '创建、查看、修改和撤销外部接口访问令牌。', addToken: '添加令牌', tokenDialog: '添加接口令牌', editTokenDialog: '修改接口令牌', tokenCreatedTitle: '令牌已创建', tokenCreatedHint: '令牌内容只在管理员会话内显示；请使用复制按钮保存。', name: '名称', tokenValue: '令牌内容', tokenValueHint: '留空时由服务端安全生成', generateToken: '生成令牌', perMinute: '每分钟请求数', prefix: '前缀', scopes: '权限范围', scopeRead: '读取', scopeGenerate: '生成', scopeAll: '全部', scopeHint: '当前接口支持读取和生成；选择全部可同时使用两项能力。', expires: '到期时间', neverExpires: '无限', lastUsed: '最近使用', create: '创建', update: '保存修改', tokenCreated: '令牌已创建', tokenUpdated: '令牌设置已更新', noTokens: '尚未创建接口令牌', revoked: '已撤销', valid: '有效', revoke: '撤销', edit: '编辑', tokenUnavailable: '仅可鉴权', confirmRevokeToken: '确定撤销这个令牌吗？',
    taskCenter: '任务中心', taskDescription: '查看同步任务、结果和失败原因。', statusLabel: '状态', actions: '操作', noRecords: '暂无记录', close: '关闭', showSecret: '显示', hideSecret: '隐藏', copySecret: '复制', copied: '已复制', revealFailed: '密钥读取失败，请重试。',
    status: { healthy: '正常', expired: '已过期', needs_review: '需检查', cooldown: '冷却中', quota_exhausted: '额度用尽', disabled: '已停用', succeeded: '已完成', failed: '失败' }
  },
  en: {
    labels: { dashboard: 'Dashboard', policies: 'Sync Policy', providers: 'Map Keys', china: 'China Sync', access: 'Access & Security', tokens: 'API Tokens', runs: 'Task Center' },
    providers: { amap: 'Amap', baidu: 'Baidu', tencent: 'Tencent', onemap: 'OneMap' },
    brandName: 'ADDRESS', brand: 'Admin Console', loginTitle: 'Administrator sign in', password: 'Administrator password', login: 'Sign in', loggingIn: 'Signing in…', backGenerator: 'Back to generator',
    bootstrap: 'Set ADMIN_BOOTSTRAP_PASSWORD on the server and restart the service first.', loading: 'Loading…', logout: 'Sign out', language: 'Chinese',
    dashboardTitle: 'Address data', dashboardDescription: 'Review imported addresses by country and administrative level.', allCountries: 'All countries', region: 'Region', level: 'Administrative level', available: 'Available addresses', residential: 'Verified residential', ordinary: 'Other addresses', children: 'Child regions', updated: 'Updated', noSubregions: 'No child regions', noAddressData: 'No address data', emptyDashboard: 'This database has no address records yet. Import or sync data to drill into countries, regions, and districts.',
    policiesTitle: 'Address volume and concurrency', policiesDescription: 'Control the latest verified snapshot by country and administrative node.', prepareConcurrency: 'Countries prepared in parallel', cpuConcurrency: 'Heavy parser concurrency', countryTarget: 'Country target', actualCount: 'Current count', difference: 'Difference', sourceVersion: 'Data version', hierarchyLimits: 'Level limits', editPolicy: 'Edit policy', browseNodes: 'Manage regions', saveRuntime: 'Save concurrency', runtimeSaved: 'Concurrency settings saved', policySaved: 'Sync policy saved', nodeOverride: 'Region target', inheritedTarget: 'Default limit', customTarget: 'Custom target', useInherited: 'Restore default', noPolicyNodes: 'No administrative nodes at this level.', policyHint: 'Targets trim address rows only. Administrative and postcode catalogs remain complete. Missing candidates are reported, never generated.', deficit: 'Missing', excess: 'Excess', ready: 'On target', backCountries: 'Back to countries', enabled: 'Include in automatic sync', unlimitedLevel: '0 disables a separate cap for that level', manage: 'Manage',
    accessTitle: 'Access policy', accessDescription: 'Choose the access path first, then save password and API protection rules.', frontendPasswordEnabled: 'Require a frontend password', apiAuthEnabled: 'Require a Bearer token for external API', newFrontendPassword: 'New frontend password', confirmFrontendPassword: 'Confirm frontend password', newAdminPassword: 'New administrator password', confirmAdminPassword: 'Confirm administrator password', passwordSection: 'Password settings', policySection: 'Access controls', keepUnchanged: 'Leave blank to keep the current value', saveSettings: 'Save settings', settingsSaved: 'Access settings saved', passwordMismatch: 'The two password entries do not match.', changeFrontendPassword: 'Change frontend password', changeAdminPassword: 'Change administrator password', passwordDialogHint: 'Enter the new password twice. The fields are cleared after saving.', passwordNew: 'New password', passwordConfirm: 'Confirm password', showPassword: 'Show', hidePassword: 'Hide', savePassword: 'Save password',
    providersTitle: 'Map keys', providersDescription: 'Manage map credentials; values stay hidden until explicitly revealed.', addKey: 'Add key', addMapKey: 'Add map key', provider: 'Provider', optionalName: 'Name (optional)', autoName: 'Leave blank to name automatically', key: 'Key', cancel: 'Cancel', save: 'Save', keySaved: 'Map key saved', stop: 'Disable', enable: 'Enable', test: 'Test', testSuccess: 'Key test succeeded', remove: 'Delete', noKeys: 'No map keys configured', quotaUsage: 'Quota', quotaDay: 'Daily', quotaMonth: 'Monthly', quotaProvider: 'Provider live', quotaLocal: 'Local count', quotaReset: 'Resets', quotaRemaining: 'remaining', lastSuccess: 'Last success',
    mapDisplayTitle: 'Frontend map display', mapChina: 'China addresses', mapInternational: 'International addresses', googleMap: 'Google Maps', amapMap: 'AMap', mapDisplaySaved: 'Map display settings saved', mapDisplayHint: 'A disabled provider loads no frontend script or frame and sends no map request.',
    amapBrowserTitle: 'AMap browser credential', configureAmapBrowser: 'Configure credential', editAmapBrowser: 'Edit credential', amapBrowserDialog: 'Configure AMap browser credential', amapBrowserLabel: 'Credential name', amapBrowserPlaceholder: 'AMap JavaScript API', amapApiKey: 'Browser API key', amapSecurityCode: 'Security code', amapBrowserSaved: 'AMap browser credential saved', amapBrowserRemoved: 'AMap browser credential deleted', amapBrowserEmpty: 'No AMap browser credential configured', amapBrowserSecurity: 'The browser receives only the dedicated domain-restricted API key. The security code and server-side sync key remain on the server.', replaceSecret: 'Leave blank to retain the current value', amapUpdated: 'Updated', amapLastUsed: 'Last used', confirmRemoveAmap: 'Delete the AMap browser credential?',
    chinaTitle: 'China sync', chinaDescription: 'Configure verified community sync and review quota and coverage progress.', chinaTotal: 'Verified communities', cities: 'Cities covered', districts: 'Districts covered', focusCities: 'Priority cities covered', crossVerified: 'Cross-provider matches', availableKeys: 'Available keys', estimate: 'Base coverage estimate', waitingKeys: 'Waiting for an available key', minutes: 'About {value} minutes', autoSync: 'Automatic sync', syncNow: 'Start / resume sync', syncing: 'Syncing', areaFallback: 'AreaCity data is not imported; priority cities are covered first, then the full district list is enabled.', areaReady: 'The system targets 10 verified communities per district, then continues enrichment automatically.', pendingCommunities: '{value} base communities remaining', focusCoverage: 'Priority city coverage', districtCoverage: 'District coverage', province: 'Province', city: 'City', district: 'District', currentCommunities: 'Current communities', target: 'Base target', covered: 'Covered', pending: 'Pending', noAreas: 'Administrative data is not initialized', platformData: 'Provider totals', syncSubmitted: 'Sync task submitted',
    tokensTitle: 'API tokens', tokensDescription: 'Create, view, edit, and revoke external API access tokens.', addToken: 'Add token', tokenDialog: 'Add API token', editTokenDialog: 'Edit API token', tokenCreatedTitle: 'Token created', tokenCreatedHint: 'The token stays inside this administrator session. Use Copy to save it.', name: 'Name', tokenValue: 'Token value', tokenValueHint: 'Leave blank to let the server generate one', generateToken: 'Generate token', perMinute: 'Requests per minute', prefix: 'Prefix', scopes: 'Scopes', scopeRead: 'Read', scopeGenerate: 'Generate', scopeAll: 'All', scopeHint: 'This API currently supports Read and Generate. Select All to enable both.', expires: 'Expires', neverExpires: 'Never', lastUsed: 'Last used', create: 'Create', update: 'Save changes', tokenCreated: 'Token created', tokenUpdated: 'Token settings updated', noTokens: 'No API tokens created', revoked: 'Revoked', valid: 'Active', revoke: 'Revoke', edit: 'Edit', tokenUnavailable: 'Authentication only', confirmRevokeToken: 'Revoke this token?',
    taskCenter: 'Task center', taskDescription: 'Review sync jobs, outcomes, and failure details.', statusLabel: 'Status', actions: 'Actions', noRecords: 'No records', close: 'Close', showSecret: 'Show', hideSecret: 'Hide', copySecret: 'Copy', copied: 'Copied', revealFailed: 'The credential could not be revealed. Try again.',
    status: { healthy: 'Healthy', expired: 'Expired', needs_review: 'Needs review', cooldown: 'Cooling down', quota_exhausted: 'Quota exhausted', disabled: 'Disabled', succeeded: 'Completed', failed: 'Failed' }
  }
} as const;

const labelsFor = (locale: AdminLocale): Record<View, string> => adminText[locale].labels;
const descriptionsFor = (locale: AdminLocale): Record<View, string> => ({
  dashboard: adminText[locale].dashboardDescription,
  policies: adminText[locale].policiesDescription,
  providers: adminText[locale].providersDescription,
  china: adminText[locale].chinaDescription,
  access: adminText[locale].accessDescription,
  tokens: adminText[locale].tokensDescription,
  runs: adminText[locale].taskDescription
});
const providerLabel = (locale: AdminLocale, provider: string): string => adminText[locale].providers[provider as keyof typeof adminText['zh-CN']['providers']] || provider;
const policyLevelLabels: Record<string, string[]> = {
  US: ['州', '县/城市', '地区'], CA: ['省/地区', '城市', '区域'], MX: ['州', '市镇', '地区'],
  GB: ['构成国/地区', '邮政城市', '区'], DE: ['联邦州', '市镇', '区'], FR: ['大区', '市镇', '区'],
  IT: ['大区', '市镇', '区'], ES: ['自治区', '市镇', '区'], NL: ['省', '市镇', '区'],
  JP: ['都道府县', '市区町村', '町域'], CN: ['省级', '地级市', '区县', '街道乡镇'],
  HK: ['地区', '分区', '区域'], TW: ['县市', '区乡镇', '村里'], KR: ['道/广域市', '市郡区', '街区'],
  SG: ['规划区', '规划区域', '地区'], MY: ['州/联邦直辖区', '县市', '地区'], TH: ['府', '县', '区'],
  PH: ['大区', '省', '市县', '描笼涯'], VN: ['省/直辖市', '郡县', '坊社'], TR: ['省', '县', '街区'],
  SA: ['地区', '城市', '区'], IN: ['邦/领地', '县市', '地区'], AU: ['州/领地', '城市', '区县'],
  BR: ['州', '市', '区'], NG: ['州', '地方政府区', '地区'], ZA: ['省', '市镇', '地区'],
  RU: ['联邦主体', '市/区', '地区']
};
const policyLevelLabel = (locale: AdminLocale, countryCode: string, index: number, fallback: string): string =>
  locale === 'zh-CN' ? policyLevelLabels[countryCode]?.[index] || `第${index + 1}级` : fallback;
const credentialDisplayLabel = (locale: AdminLocale, label: string): string => ({
  'zh-CN': { AMAP_API_KEY: '高德同步密钥', BAIDU_API_KEY: '百度同步密钥', TENCENT_API_KEY: '腾讯同步密钥', ONEMAP_ACCESS_TOKEN: '新加坡地图访问令牌', AMAP_JS_API_KEY: '高德浏览器地图密钥' },
  en: { AMAP_API_KEY: 'AMap sync key', BAIDU_API_KEY: 'Baidu sync key', TENCENT_API_KEY: 'Tencent sync key', ONEMAP_ACCESS_TOKEN: 'OneMap access token', AMAP_JS_API_KEY: 'AMap browser key' }
}[locale] as Record<string, string>)[label] || label;
const interpolate = (value: string, replacements: Record<string, string | number>): string => Object.entries(replacements).reduce((result, [key, replacement]) => result.replace(`{${key}}`, String(replacement)), value);
const dateTime = (value: unknown, locale: AdminLocale) => value ? new Date(String(value)).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-GB', { hour12: false }) : '-';
const dateInputValue = (value: unknown): string => {
  if (!value) return '';
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const generateTokenValue = (): string => {
  const bytes = new Uint8Array(24);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let encoded = '';
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return `addr_${btoa(encoded).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
};
const errorMessage = (value: unknown, locale: AdminLocale = 'zh-CN'): string => {
  const code = value instanceof Error ? value.message : String(value);
  return ({
    'zh-CN': { UNAUTHORIZED: '登录状态已失效，请重新登录', INVALID_CREDENTIALS: '管理员密码错误', LOGIN_RATE_LIMITED: '登录尝试过多，请稍后再试', PASSWORD_LENGTH: '密码长度必须为 10 至 512 个字符', PASSWORD_CONFIRM_MISMATCH: '两次输入的密码不一致', FRONTEND_PASSWORD_REQUIRED: '启用前端访问密码时必须先设置密码', TOKEN_NAME_REQUIRED: '请输入令牌名称', INVALID_TOKEN_RATE_LIMIT: '令牌限速设置无效', INVALID_TOKEN_VALUE: '令牌内容长度或格式无效', INVALID_TOKEN_SCOPES: '令牌权限无效', INVALID_TOKEN_EXPIRY: '令牌到期时间无效', TOKEN_ALREADY_EXISTS: '令牌内容已经存在', API_TOKEN_NOT_FOUND: '令牌不存在', API_TOKEN_SECRET_UNAVAILABLE: '该令牌仅保留鉴权信息', NO_AVAILABLE_KEY: '请先添加至少一个未过期的可用凭据', PROVIDER_TEST_FAILED: '服务凭据测试失败', INVALID_USER_KEY: '服务凭据无效', CHINA_SYNC_BUSY: '已有中国同步任务正在运行', CREDENTIAL_NOT_FOUND: '服务凭据不存在', INVALID_PROVIDER_CREDENTIAL: '服务凭据配置无效', INVALID_MAP_DISPLAY_CONFIG: '地图显示设置无效', INVALID_BROWSER_MAP_CREDENTIAL: '高德地图浏览器密钥配置无效', BROWSER_MAP_CREDENTIAL_EXISTS: '高德地图浏览器密钥已存在', BROWSER_MAP_CREDENTIAL_NOT_FOUND: '高德地图浏览器密钥不存在', AREACITY_DATA_EMPTY: '行政区划数据为空', INVALID_AREACITY_CSV: '行政区划逗号分隔文件格式无效', AREACITY_SOURCE_OUTSIDE_DATA_ROOT: '行政区划文件必须位于本地数据目录内' },
    en: { UNAUTHORIZED: 'Your session has expired. Sign in again.', INVALID_CREDENTIALS: 'The administrator password is incorrect.', LOGIN_RATE_LIMITED: 'Too many sign-in attempts. Try again later.', PASSWORD_LENGTH: 'Password length must be 10 to 512 characters.', PASSWORD_CONFIRM_MISMATCH: 'The two password entries do not match.', FRONTEND_PASSWORD_REQUIRED: 'Set a frontend password before enabling this option.', TOKEN_NAME_REQUIRED: 'Enter a token name.', INVALID_TOKEN_RATE_LIMIT: 'The token rate limit is invalid.', INVALID_TOKEN_VALUE: 'The token value has an invalid length or format.', INVALID_TOKEN_SCOPES: 'The token scopes are invalid.', INVALID_TOKEN_EXPIRY: 'The token expiry is invalid.', TOKEN_ALREADY_EXISTS: 'That token value already exists.', API_TOKEN_NOT_FOUND: 'The token was not found.', API_TOKEN_SECRET_UNAVAILABLE: 'This token only retains authentication data.', NO_AVAILABLE_KEY: 'Add at least one enabled, non-expired credential.', PROVIDER_TEST_FAILED: 'The credential test failed.', INVALID_USER_KEY: 'The service credential is invalid.', CHINA_SYNC_BUSY: 'A China sync task is already running.', CREDENTIAL_NOT_FOUND: 'The service credential was not found.', INVALID_PROVIDER_CREDENTIAL: 'The credential configuration is invalid.', INVALID_MAP_DISPLAY_CONFIG: 'The map display configuration is invalid.', INVALID_BROWSER_MAP_CREDENTIAL: 'The AMap browser credential is invalid.', BROWSER_MAP_CREDENTIAL_EXISTS: 'An AMap browser credential already exists.', BROWSER_MAP_CREDENTIAL_NOT_FOUND: 'The AMap browser credential was not found.', AREACITY_DATA_EMPTY: 'The AreaCity data is empty.', INVALID_AREACITY_CSV: 'The AreaCity CSV format is invalid.', AREACITY_SOURCE_OUTSIDE_DATA_ROOT: 'The AreaCity file must be inside the local data directory.' }
  }[locale] as Record<string, string>)[code] || code;
};
const cookie = (name: string): string => document.cookie.split('; ').find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const initialLocale = (): AdminLocale => {
  if (typeof window === 'undefined') return 'zh-CN';
  try { return window.localStorage.getItem('address-admin-locale') === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; }
};
const coverageLevels: Record<AdminLocale, Record<string, string[]>> = {
  'zh-CN': {
    CN: ['国家', '省级', '地级市', '区县', '街道乡镇'], US: ['国家', '州', '城市', '区县'], CA: ['国家', '省', '城市', '区域'],
    JP: ['国家', '都道府县', '市区町村', '地区'], GB: ['国家', '构成国或地区', '城市', '区域'], default: ['国家', '一级行政区', '城市', '区县', '下级区域']
  },
  en: {
    CN: ['Country', 'Province-level', 'Prefecture-level city', 'District or county', 'Township'], US: ['Country', 'State', 'City', 'County'], CA: ['Country', 'Province', 'City', 'Region'],
    JP: ['Country', 'Prefecture', 'Municipality', 'District'], GB: ['Country', 'Constituent country or region', 'City', 'Region'], default: ['Country', 'First-level division', 'City', 'District', 'Child region']
  }
};
const coverageLevelName = (node: CoverageNode, locale: AdminLocale): string => coverageLevels[locale][node.countryCode]?.[node.level] || coverageLevels[locale].default[node.level] || adminText[locale].region;
const coverageRegionName = (node: CoverageNode, locale: AdminLocale): string => {
  if (node.level !== 0 || !isCountryCode(node.countryCode)) return node.regionName;
  return countryByCode.get(node.countryCode)?.name[locale] || node.regionName;
};

export default function SyncAdmin() {
  const [locale, setLocale] = useState<AdminLocale>(initialLocale);
  const t = adminText[locale];
  const [authenticated, setAuthenticated] = useState(false);
  const [initialized, setInitialized] = useState(true);
  const [password, setPassword] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [dataByView, setDataByView] = useState<Partial<Record<View, unknown>>>({});
  const [loadingView, setLoadingView] = useState<View | null>(null);
  const [mutating, setMutating] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [coverageTrail, setCoverageTrail] = useState<CoverageNode[]>([]);
  const loadIds = useRef<Record<View, number>>({ dashboard: 0, policies: 0, access: 0, providers: 0, china: 0, tokens: 0, runs: 0 });
  const viewRef = useRef<View>('dashboard');
  const coverageParent = useRef('');

  const changeLocale = (next: AdminLocale) => {
    setLocale(next);
    try { window.localStorage.setItem('address-admin-locale', next); } catch { /* storage is optional */ }
  };

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = locale === 'zh-CN' ? '地址管理系统' : 'Address Admin Console';
  }, [locale]);

  const request = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const csrf = cookie('address_admin_csrf');
    const response = await fetch(`/admin/api${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(15000),
      cache: 'no-store',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers },
      credentials: 'same-origin'
    });
    const body = await response.json() as { data?: T; error?: string; detail?: string };
    if (response.status === 401) setAuthenticated(false);
    if (!response.ok) throw new Error(errorMessage(body.detail || body.error || `HTTP ${response.status}`, locale));
    return body.data as T;
  }, [locale]);

  const reveal = useCallback(async (path: string): Promise<Record<string, string>> => {
    return request<Record<string, string>>(path, { method: 'POST' });
  }, [request]);

  const load = useCallback(async (selected: View, clearMessages = true, background = false): Promise<boolean> => {
    const id = ++loadIds.current[selected];
    if (!background) setLoadingView(selected);
    setError(''); if (clearMessages) setNotice('');
    try {
      const paths: Record<View, string> = {
        dashboard: `/dashboard/coverage${coverageParent.current ? `?parent=${encodeURIComponent(coverageParent.current)}` : ''}`,
        policies: '/sync/policies', access: '/settings/access', providers: '/providers', china: '/china/status', tokens: '/tokens', runs: '/runs'
      };
      const result = selected === 'providers'
        ? { credentials: await request('/providers'), maps: await request('/settings/maps') }
        : await request(paths[selected]);
      if (id === loadIds.current[selected]) setDataByView((values) => ({ ...values, [selected]: result }));
      return true;
    } catch (value) {
      if (id === loadIds.current[selected] && selected === viewRef.current) setError(errorMessage(value, locale));
      return false;
    } finally {
      if (id === loadIds.current[selected] && !background) setLoadingView((value) => value === selected ? null : value);
    }
  }, [request, locale]);

  useEffect(() => {
    void fetch('/admin/api/status').then((response) => response.json()).then((body) => setInitialized(Boolean(body.data?.initialized)))
      .catch((value) => setError(errorMessage(value, locale)));
    void fetch('/admin/api/session', { credentials: 'same-origin' }).then((response) => response.json()).then((body) => {
      const active = Boolean(body.data?.authenticated);
      setAuthenticated(active);
      if (active) void load(viewRef.current);
    }).catch((value) => setError(errorMessage(value, locale)));
  }, [load, locale]);

  useEffect(() => {
    if (!authenticated || !['china', 'runs'].includes(view)) return;
    const interval = window.setInterval(() => void load(view, false, true), 1500);
    return () => window.clearInterval(interval);
  }, [authenticated, load, view]);

  const login = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoginBusy(true); setError('');
    try {
      const result = await fetch('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), credentials: 'same-origin' });
      const body = await result.json();
      if (!result.ok) throw new Error(errorMessage(body.error || 'LOGIN_FAILED', locale));
      setAuthenticated(true); setPassword('');
      setTimeout(() => void load('dashboard'), 0);
    } catch (value) { setError(errorMessage(value, locale)); }
    finally { setLoginBusy(false); }
  };

  const mutate: Mutate = async <T,>(path: string, method: string, body?: unknown, success = locale === 'zh-CN' ? '操作已完成' : 'Operation completed'): Promise<T | undefined> => {
    const selected = viewRef.current;
    setMutating(true); setError(''); setNotice('');
    try {
      const result = await request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (await load(selected, false, true)) setNotice(success);
      return result;
    } catch (value) { setError(errorMessage(value, locale)); return undefined; }
    finally { setMutating(false); }
  };

  if (!authenticated) return <main className="admin-login">
    <form onSubmit={login}>
      <div className="admin-login-toolbar"><p>{t.brandName}{locale === 'zh-CN' ? '' : ' '}{t.brand}</p><button type="button" className="locale-toggle" onClick={() => changeLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>{t.language}</button></div>
      <h1>{t.loginTitle}</h1>
      {!initialized && <div className="admin-warning">{t.bootstrap}</div>}
      <label><span>{t.password}</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button disabled={loginBusy || !password}>{loginBusy ? t.loggingIn : t.login}</button>
      {error && <div className="admin-error" role="alert">{error}</div>}
      <a href={locale === 'zh-CN' ? '/zh-CN/' : '/en/'}>{t.backGenerator}</a>
    </form>
  </main>;

  const selectView = (selected: View) => {
    if (selected === 'dashboard') { coverageParent.current = ''; setCoverageTrail([]); }
    viewRef.current = selected; setView(selected); void load(selected);
  };
  const openCoverage = (node: CoverageNode) => {
    if (!node.childCount) return;
    coverageParent.current = node.key;
    setCoverageTrail((trail) => [...trail, node]);
    void load('dashboard');
  };
  const returnCoverage = (index: number) => {
    const trail = coverageTrail.slice(0, index + 1);
    coverageParent.current = index < 0 ? '' : trail[index].key;
    setCoverageTrail(trail);
    void load('dashboard');
  };
  const logout = async () => {
    try { await request('/logout', { method: 'POST' }); location.reload(); }
    catch (value) { setError(errorMessage(value, locale)); }
  };
  const data = dataByView[view];

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="admin-brand"><b>{t.brandName}</b><span>{t.brand}</span></div>
      <nav>{(Object.keys(labelsFor(locale)) as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => selectView(item)}>{labelsFor(locale)[item]}</button>)}</nav>
    </aside>
    <main className="admin-content">
      <header className="admin-topbar">
        <div className="admin-topbar-copy"><p className="admin-eyebrow">{t.brandName}{locale === 'zh-CN' ? '' : ' '}{t.brand}</p><h1>{labelsFor(locale)[view]}</h1><p>{descriptionsFor(locale)[view]}</p></div>
        <div className="admin-topbar-actions"><button className="topbar-control" onClick={() => changeLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>{t.language}</button><a className="topbar-control" href={locale === 'zh-CN' ? '/zh-CN/' : '/en/'}>{t.backGenerator}</a><button className="topbar-control danger-control" onClick={() => void logout()}>{t.logout}</button></div>
      </header>
      {error && <div className="admin-error" role="alert">{error}</div>}
      {notice && <div className="admin-notice">{notice}</div>}
      {data === undefined ? <div className="admin-loading" role="status"><span className="loading-dot" />{t.loading}</div> : <AdminView locale={locale} view={view} data={data} busy={mutating} mutate={mutate} reveal={reveal} request={request}
        coverageTrail={coverageTrail} openCoverage={openCoverage} returnCoverage={returnCoverage} />}
      {data !== undefined && loadingView === view && <div className="admin-refreshing" role="status" aria-label={t.loading}><span className="loading-dot" /></div>}
    </main>
  </div>;
}

function AdminView({ locale, view, data, busy, mutate, reveal, request, coverageTrail, openCoverage, returnCoverage }: {
  locale: AdminLocale; view: View; data: unknown; busy: boolean; mutate: Mutate; reveal: Reveal; request: RequestData;
  coverageTrail: CoverageNode[]; openCoverage: (node: CoverageNode) => void; returnCoverage: (index: number) => void;
}) {
  const t = adminText[locale];
  const [providerDialog, setProviderDialog] = useState(false);
  const [amapBrowserDialog, setAmapBrowserDialog] = useState(false);
  const [tokenEditor, setTokenEditor] = useState<{ mode: 'create' | 'edit'; value?: ApiTokenView } | null>(null);
  const [tokenSecret, setTokenSecret] = useState<string | null>(null);
  if (view === 'dashboard') {
    const nodes = (data || []) as CoverageNode[];
    return <Panel title={t.dashboardTitle}>
      <div className="coverage-breadcrumb"><button onClick={() => returnCoverage(-1)}>{t.allCountries}</button>{coverageTrail.map((node, index) => <span key={node.key}>/<button onClick={() => returnCoverage(index)}>{coverageRegionName(node, locale)}</button></span>)}</div>
      {(!nodes.length || nodes.every((node) => node.totalCount === 0)) && <div className="empty-state"><strong>{t.noAddressData}</strong><span>{t.emptyDashboard}</span></div>}
      <CoverageTable values={nodes} open={openCoverage} locale={locale} />
    </Panel>;
  }
  if (view === 'access') {
    const value = data as { frontendPasswordEnabled?: boolean; apiAuthEnabled?: boolean } | undefined;
    return <Panel title={t.accessTitle}><AccessSettingsForm value={value} locale={locale} busy={busy} mutate={mutate} /></Panel>;
  }
  if (view === 'policies') return <PolicySettings value={data as PolicyViewData} locale={locale} busy={busy} mutate={mutate} request={request} />;
  if (view === 'providers') {
    const value = data as ProviderViewData;
    const credentials = value.credentials || [];
    const maps = value.maps;
    return <><MapDisplayPanel value={maps} locale={locale} busy={busy} mutate={mutate} />
      <Panel title={t.amapBrowserTitle} actions={<button className="primary-action" onClick={() => setAmapBrowserDialog(true)}>{maps.amapBrowser.configured ? t.editAmapBrowser : `+ ${t.configureAmapBrowser}`}</button>}>
        <AmapBrowserSummary value={maps.amapBrowser} locale={locale} busy={busy} mutate={mutate} reveal={reveal} />
      </Panel>
      <Panel title={t.providersTitle} actions={<button className="primary-action" onClick={() => setProviderDialog(true)}>+ {t.addKey}</button>}>
      <CredentialTable values={credentials} locale={locale} reveal={reveal} actions={(credential) => <><button disabled={busy} onClick={() => void mutate(`/providers/${credential.id}`, 'PUT', { enabled: !credential.enabled }, credential.enabled ? t.stop : t.enable)}>{credential.enabled ? t.stop : t.enable}</button><button disabled={busy} onClick={() => void mutate(`/providers/${credential.id}/test`, 'POST', undefined, t.testSuccess)}>{t.test}</button><button disabled={busy} className="danger" onClick={() => void mutate(`/providers/${credential.id}`, 'DELETE', undefined, t.remove)}>{t.remove}</button></>} />
    </Panel>{amapBrowserDialog && <AmapBrowserDialog value={maps.amapBrowser} locale={locale} busy={busy} mutate={mutate} close={() => setAmapBrowserDialog(false)} />}{providerDialog && <Dialog title={t.addMapKey} close={() => setProviderDialog(false)} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
      event.preventDefault(); const values = new FormData(event.currentTarget); const provider = String(values.get('provider'));
      const created = await mutate('/providers', 'POST', { provider, label: values.get('label') || `${providerLabel(locale, provider)} ${t.key}`, secret: values.get('secret') }, t.keySaved);
      if (created) setProviderDialog(false);
    }}><label><span>{t.provider}</span><select name="provider"><option value="amap">{t.providers.amap}</option><option value="baidu">{t.providers.baidu}</option><option value="tencent">{t.providers.tencent}</option><option value="onemap">{t.providers.onemap}</option></select></label>
      <label><span>{t.optionalName}</span><input name="label" placeholder={t.autoName} /></label><label><span>{t.key}</span><input name="secret" type="password" required autoComplete="new-password" /></label>
      <div className="dialog-actions"><button type="button" onClick={() => setProviderDialog(false)}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div></form></Dialog>}</>;
  }
  if (view === 'china') {
    const value = data as { total?: number; cross_verified?: number; cities?: number; usingFallback?: boolean; running?: boolean; coverage?: Record<string, unknown>; estimate?: Record<string, unknown>; sources?: Array<Record<string, unknown>>; areas?: Array<Record<string, unknown>> } | undefined;
    const coverage = value?.coverage || {}; const estimate = value?.estimate || {};
    const minutes = estimate.estimatedMinutes == null ? t.waitingKeys : interpolate(t.minutes, { value: Number(estimate.estimatedMinutes).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') });
    return <><section className="metric-grid"><Metric label={t.chinaTotal} value={Number(value?.total || 0).toLocaleString()} /><Metric label={t.cities} value={String(value?.cities || 0)} /><Metric label={value?.usingFallback ? t.focusCities : t.districts} value={`${Number(coverage.districts_covered || 0).toLocaleString()} / ${Number(coverage.districts_total || 0).toLocaleString()}`} /><Metric label={t.crossVerified} value={String(value?.cross_verified || 0)} /><Metric label={t.availableKeys} value={String(estimate.activeKeys || 0)} /><Metric label={t.estimate} value={minutes} /></section>
      <Panel title={t.autoSync} actions={<button className="primary-action" disabled={busy || value?.running} onClick={() => void mutate('/china/sync', 'POST', {}, t.syncSubmitted)}>{value?.running ? t.syncing : t.syncNow}</button>}>
        <div className="sync-summary"><span>{value?.usingFallback ? t.areaFallback : t.areaReady}</span><b>{interpolate(t.pendingCommunities, { value: Number(estimate.remainingCommunities || 0).toLocaleString() })}</b></div>
      </Panel><Panel title={value?.usingFallback ? t.focusCoverage : t.districtCoverage}><AreaCoverageTable values={value?.areas || []} locale={locale} /></Panel><Panel title={t.platformData}><JsonTable values={value?.sources || []} locale={locale} /></Panel></>;
  }
  if (view === 'tokens') {
    const tokens = ((data || []) as ApiTokenView[]).filter((token) => !token.revoked_at);
    return <><Panel title={t.tokensTitle} actions={<button className="primary-action" onClick={() => setTokenEditor({ mode: 'create' })}>+ {t.addToken}</button>}>
      <TokenTable values={tokens} locale={locale} reveal={reveal} edit={(value) => setTokenEditor({ mode: 'edit', value })} revoke={(id) => {
        if (window.confirm(t.confirmRevokeToken)) void mutate(`/tokens/${id}`, 'DELETE', undefined, t.revoked);
      }} />
    </Panel>{tokenEditor && <TokenEditorDialog mode={tokenEditor.mode} value={tokenEditor.value} locale={locale} busy={busy} mutate={mutate} close={() => setTokenEditor(null)} created={(value) => { setTokenEditor(null); setTokenSecret(value); }} />}{tokenSecret && <TokenSecretDialog value={tokenSecret} locale={locale} close={() => setTokenSecret(null)} />}</>;
  }
  return <Panel title={t.taskCenter}><JsonTable values={(data || []) as Array<Record<string, unknown>>} locale={locale} /></Panel>;
}

function PolicySettings({ value, locale, busy, mutate, request }: { value: PolicyViewData; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData }) {
  const t = adminText[locale];
  const [runtime, setRuntime] = useState(value.runtime);
  const [countryEditor, setCountryEditor] = useState<CountryPolicy | null>(null);
  const [nodes, setNodes] = useState<PolicyNode[] | null>(null);
  const [nodeTrail, setNodeTrail] = useState<Array<{ key: string; name: string }>>([]);
  const [nodeEditor, setNodeEditor] = useState<PolicyNode | null>(null);
  useEffect(() => setRuntime(value.runtime), [value.runtime.prepareConcurrency, value.runtime.cpuConcurrency]);
  const loadNodes = async (parent: string, trail: Array<{ key: string; name: string }>) => {
    const result = await request<PolicyNode[]>(`/sync/policies/nodes?parent=${encodeURIComponent(parent)}`);
    setNodes(result); setNodeTrail(trail);
  };
  if (nodes) return <><Panel title={t.nodeOverride} actions={<button className="secondary-action" onClick={() => { setNodes(null); setNodeTrail([]); }}>{t.backCountries}</button>}>
    <div className="coverage-breadcrumb">{nodeTrail.map((node, index) => <span key={node.key}>/<button onClick={() => void loadNodes(node.key, nodeTrail.slice(0, index + 1))}>{node.name}</button></span>)}</div>
    <div className="table-scroll"><table><thead><tr><th>{t.region}</th><th>{t.level}</th><th>{t.actualCount}</th><th>{t.inheritedTarget}</th><th>{t.customTarget}</th><th>{t.difference}</th><th>{t.actions}</th></tr></thead><tbody>{nodes.map((node) => <tr key={node.key}>
      <td><button className="drill-button" disabled={!node.childCount} onClick={() => void loadNodes(node.key, [...nodeTrail, { key: node.key, name: node.regionName }])}>{node.regionName}</button></td>
      <td>{node.level}</td><td>{node.currentCount.toLocaleString()}</td><td>{node.inheritedTarget.toLocaleString()}</td><td>{node.overrideTarget == null ? '-' : node.overrideTarget.toLocaleString()}</td>
      <td><PolicyDifference value={node} locale={locale} /></td><td className="row-actions"><button onClick={() => setNodeEditor(node)}>{t.edit}</button>{node.overrideTarget != null && <button disabled={busy} onClick={async () => { await mutate(`/sync/policies/nodes?key=${encodeURIComponent(node.key)}`, 'DELETE', undefined, t.policySaved); await loadNodes(node.parentKey, nodeTrail); }}>{t.useInherited}</button>}</td>
    </tr>)}</tbody></table>{!nodes.length && <p className="admin-empty">{t.noPolicyNodes}</p>}</div>
  </Panel>{nodeEditor && <NodePolicyDialog value={nodeEditor} locale={locale} busy={busy} close={() => setNodeEditor(null)} save={async (targetCount) => {
    const result = await mutate('/sync/policies/nodes', 'PUT', { key: nodeEditor.key, targetCount }, t.policySaved);
    if (result) { setNodeEditor(null); await loadNodes(nodeEditor.parentKey, nodeTrail); }
  }} />}</>;
  return <><Panel title={t.policiesTitle}>
    <form className="policy-runtime-form" onSubmit={async (event) => { event.preventDefault(); await mutate('/sync/policies/runtime', 'PUT', runtime, t.runtimeSaved); }}>
      <label><span>{t.prepareConcurrency}</span><input type="number" min="1" max="10" value={runtime.prepareConcurrency} onChange={(event) => setRuntime({ ...runtime, prepareConcurrency: Number(event.target.value) })} /></label>
      <label><span>{t.cpuConcurrency}</span><input type="number" min="1" max="4" value={runtime.cpuConcurrency} onChange={(event) => setRuntime({ ...runtime, cpuConcurrency: Number(event.target.value) })} /></label>
      <button className="primary-action" disabled={busy}>{t.saveRuntime}</button>
    </form><p className="policy-hint">{t.policyHint}</p>
  </Panel><Panel title={t.countryTarget}><div className="table-scroll"><table><thead><tr><th>{t.region}</th><th>{t.actualCount}</th><th>{t.countryTarget}</th><th>{t.difference}</th><th>{t.sourceVersion}</th><th>{t.hierarchyLimits}</th><th>{t.actions}</th></tr></thead><tbody>{value.countries.map((country) => <tr key={country.countryCode}>
    <td><b>{isCountryCode(country.countryCode) ? countryByCode.get(country.countryCode)?.name[locale] : country.countryCode}</b><small className="table-subtitle">{country.countryCode}</small></td>
    <td>{country.currentCount.toLocaleString()}</td><td>{country.targetCount.toLocaleString()}</td><td><PolicyDifference value={country} locale={locale} /></td><td>{country.sourceVersion || '-'}</td><td>{[country.level1Limit, country.level2Limit, country.level3Limit, country.level4Limit].join(' / ')}</td>
    <td className="row-actions"><button onClick={() => setCountryEditor(country)}>{t.editPolicy}</button><button onClick={() => void loadNodes(country.countryCode, [{ key: country.countryCode, name: isCountryCode(country.countryCode) ? countryByCode.get(country.countryCode)?.name[locale] || country.countryCode : country.countryCode }])}>{t.browseNodes}</button></td>
  </tr>)}</tbody></table></div></Panel>{countryEditor && <CountryPolicyDialog value={countryEditor} locale={locale} busy={busy} mutate={mutate} close={() => setCountryEditor(null)} />}</>;
}

const PolicyDifference = ({ value, locale }: { value: { deficit: number; excess: number }; locale: AdminLocale }) => {
  const t = adminText[locale];
  if (value.deficit) return <span className="badge cooldown">{t.deficit} {value.deficit.toLocaleString()}</span>;
  if (value.excess) return <span className="badge needs_review">{t.excess} {value.excess.toLocaleString()}</span>;
  return <span className="badge succeeded">{t.ready}</span>;
};

function CountryPolicyDialog({ value, locale, busy, mutate, close }: { value: CountryPolicy; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void }) {
  const t = adminText[locale];
  return <Dialog title={t.editPolicy} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    const body = { enabled: fields.get('enabled') === 'on', targetCount: Number(fields.get('targetCount')),
      level1Limit: Number(fields.get('level1Limit')), level2Limit: Number(fields.get('level2Limit')),
      level3Limit: Number(fields.get('level3Limit')), level4Limit: Number(fields.get('level4Limit')) };
    if (await mutate(`/sync/policies/countries/${value.countryCode}`, 'PUT', body, t.policySaved)) close();
  }}><label className="check"><input name="enabled" type="checkbox" defaultChecked={value.enabled} />{t.enabled}</label>
    <label><span>{t.countryTarget}</span><input name="targetCount" type="number" min="1" max="2000000" defaultValue={value.targetCount} required /></label>
    {value.labels.map((label, index) => label && <label key={label}><span>{policyLevelLabel(locale, value.countryCode, index, label)}</span><input name={`level${index + 1}Limit`} type="number" min="0" max="1000000" defaultValue={value[`level${index + 1}Limit` as keyof CountryPolicy] as number} required /></label>)}
    <small>{t.unlimitedLevel}</small><div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}

function NodePolicyDialog({ value, locale, busy, save, close }: { value: PolicyNode; locale: AdminLocale; busy: boolean; save: (target: number) => Promise<void>; close: () => void }) {
  const t = adminText[locale];
  return <Dialog title={t.nodeOverride} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget); await save(Number(fields.get('targetCount')));
  }}><div className="dialog-readonly"><span>{t.region}</span><b>{value.regionName}</b></div><div className="dialog-readonly"><span>{t.inheritedTarget}</span><b>{value.inheritedTarget.toLocaleString()}</b></div>
    <label><span>{t.customTarget}</span><input name="targetCount" type="number" min="0" max="1000000" defaultValue={value.overrideTarget ?? value.targetCount} required /></label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}

function AccessSettingsForm({ value, locale, busy, mutate }: { value?: { frontendPasswordEnabled?: boolean; apiAuthEnabled?: boolean }; locale: AdminLocale; busy: boolean; mutate: Mutate }) {
  const t = adminText[locale];
  const [passwordDialog, setPasswordDialog] = useState<'frontend' | 'admin' | null>(null);
  return <><form className="admin-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutate('/settings/access', 'PUT', {
      frontendPasswordEnabled: values.get('frontendPasswordEnabled') === 'on',
      apiAuthEnabled: values.get('apiAuthEnabled') === 'on'
    }, t.settingsSaved);
  }}>
    <div className="setting-group"><h3>{t.policySection}</h3><label className="check"><input name="frontendPasswordEnabled" type="checkbox" defaultChecked={value?.frontendPasswordEnabled} />{t.frontendPasswordEnabled}</label><label className="check"><input name="apiAuthEnabled" type="checkbox" defaultChecked={value?.apiAuthEnabled} />{t.apiAuthEnabled}</label></div>
    <div className="setting-group"><h3>{t.passwordSection}</h3><div className="password-action-list"><div className="password-action-row"><div><strong>{t.newFrontendPassword}</strong><small>{t.keepUnchanged}</small></div><button type="button" disabled={busy} onClick={() => setPasswordDialog('frontend')}>{t.changeFrontendPassword}</button></div><div className="password-action-row"><div><strong>{t.newAdminPassword}</strong><small>{t.keepUnchanged}</small></div><button type="button" disabled={busy} onClick={() => setPasswordDialog('admin')}>{t.changeAdminPassword}</button></div></div></div>
    <button className="primary-action form-submit" disabled={busy}>{t.saveSettings}</button>
  </form>{passwordDialog && <PasswordDialog kind={passwordDialog} locale={locale} busy={busy} mutate={mutate} close={() => setPasswordDialog(null)} />}</>;
}

function PasswordDialog({ kind, locale, busy, mutate, close }: { kind: 'frontend' | 'admin'; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void }) {
  const t = adminText[locale];
  const [showNew, setShowNew] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [formError, setFormError] = useState('');
  const title = kind === 'frontend' ? t.changeFrontendPassword : t.changeAdminPassword;
  return <Dialog title={title} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') || '');
    const confirmation = String(values.get('confirmation') || '');
    if (password !== confirmation) { setFormError(t.passwordMismatch); return; }
    setFormError('');
    const body = kind === 'frontend'
      ? { frontendPassword: password, frontendPasswordConfirmation: confirmation }
      : { adminPassword: password, adminPasswordConfirmation: confirmation };
    if (await mutate('/settings/access', 'PUT', body, t.settingsSaved)) close();
  }}>
    <p className="dialog-hint">{t.passwordDialogHint}</p>
    <SecretInput label={t.passwordNew} name="password" visible={showNew} toggle={() => setShowNew((current) => !current)} locale={locale} required />
    <SecretInput label={t.passwordConfirm} name="confirmation" visible={showConfirmation} toggle={() => setShowConfirmation((current) => !current)} locale={locale} required />
    {formError && <p className="field-error" role="alert">{formError}</p>}
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.savePassword}</button></div>
  </form></Dialog>;
}

function SecretInput({ label, name, visible, toggle, locale, required = false, value, onChange }: { label: string; name: string; visible: boolean; toggle: () => void; locale: AdminLocale; required?: boolean; value?: string; onChange?: (value: string) => void }) {
  const t = adminText[locale];
  return <label className="secret-input-field"><span>{label}</span><div><input name={name} type={visible ? 'text' : 'password'} minLength={10} required={required} autoComplete="new-password" value={value} onChange={onChange ? (event) => onChange(event.target.value) : undefined} /><button type="button" className="inline-toggle" onClick={toggle}>{visible ? t.hidePassword : t.showPassword}</button></div></label>;
}

const scopesForForm = (scopes: string[] | undefined): string[] => {
  if (!scopes?.length || scopes.includes('*')) return ['read', 'generate'];
  return scopes.filter((scope) => scope === 'read' || scope === 'generate');
};
const scopesForApi = (scopes: string[]): string[] => scopes.includes('read') && scopes.includes('generate') ? ['*'] : scopes.length ? scopes : ['*'];

function ScopePicker({ locale, value, onChange }: { locale: AdminLocale; value: string[]; onChange: (value: string[]) => void }) {
  const t = adminText[locale];
  const toggle = (scope: 'read' | 'generate', enabled: boolean) => {
    const next = new Set(value);
    if (enabled) next.add(scope); else next.delete(scope);
    onChange([...next]);
  };
  const all = value.includes('read') && value.includes('generate');
  return <fieldset className="scope-picker"><legend>{t.scopes}</legend><div className="scope-options"><label className="check"><input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked ? ['read', 'generate'] : [])} />{t.scopeAll}</label><label className="check"><input type="checkbox" checked={value.includes('read')} onChange={(event) => toggle('read', event.target.checked)} />{t.scopeRead}</label><label className="check"><input type="checkbox" checked={value.includes('generate')} onChange={(event) => toggle('generate', event.target.checked)} />{t.scopeGenerate}</label></div><small>{t.scopeHint}</small></fieldset>;
}

function TokenEditorDialog({ mode, value, locale, busy, mutate, close, created }: { mode: 'create' | 'edit'; value?: ApiTokenView; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void; created: (token: string) => void }) {
  const t = adminText[locale];
  const [name, setName] = useState(value?.name || '');
  const [tokenValue, setTokenValue] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [rateLimit, setRateLimit] = useState(String(value?.rate_limit_per_minute || 60));
  const [expiresAt, setExpiresAt] = useState(dateInputValue(value?.expires_at));
  const [scopes, setScopes] = useState(scopesForForm(value?.scopes));
  const isCreate = mode === 'create';
  return <Dialog title={isCreate ? t.tokenDialog : t.editTokenDialog} close={close} locale={locale}><form className="dialog-form token-editor-form" onSubmit={async (event) => {
    event.preventDefault();
    const expiry = expiresAt ? new Date(expiresAt).toISOString() : null;
    const body = isCreate
      ? { name: name.trim(), token: tokenValue.trim() || undefined, scopes: scopesForApi(scopes), rateLimit: Number(rateLimit), expiresAt: expiry }
      : { scopes: scopesForApi(scopes), rateLimit: Number(rateLimit), expiresAt: expiry };
    const result = await mutate<{ id: string; token?: string }>(isCreate ? '/tokens' : `/tokens/${value?.id}`, isCreate ? 'POST' : 'PUT', body, isCreate ? '' : t.tokenUpdated);
    if (!result) return;
    if (isCreate) created(String(result.token || '')); else close();
  }}>
    {isCreate ? <label><span>{t.name}</span><input name="name" value={name} required onChange={(event) => setName(event.target.value)} /></label> : <div className="dialog-readonly"><span>{t.name}</span><b>{value?.name}</b></div>}
    {isCreate && <label className="secret-input-field"><span>{t.tokenValue}</span><div><input name="token" type={showToken ? 'text' : 'password'} value={tokenValue} placeholder={t.tokenValueHint} autoComplete="off" onChange={(event) => setTokenValue(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setShowToken((current) => !current)}>{showToken ? t.hidePassword : t.showPassword}</button></div><small>{t.tokenValueHint}</small></label>}
    {isCreate && <button type="button" className="secondary-action generate-token-button" onClick={() => { setTokenValue(generateTokenValue()); setShowToken(true); }}>{t.generateToken}</button>}
    <ScopePicker locale={locale} value={scopes} onChange={setScopes} />
    <label><span>{t.perMinute}</span><input name="rateLimit" type="number" min="1" max="100000" required value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} /></label>
    <label><span>{t.expires}</span><input name="expiresAt" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /><small>{t.neverExpires}</small></label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{isCreate ? t.create : t.update}</button></div>
  </form></Dialog>;
}

function TokenSecretDialog({ value, locale, close }: { value: string; locale: AdminLocale; close: () => void }) {
  const t = adminText[locale];
  const [visible, setVisible] = useState(true);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
  };
  return <Dialog title={t.tokenCreatedTitle} close={close} locale={locale}><div className="token-secret-dialog"><p>{t.tokenCreatedHint}</p><code>{visible ? value : '••••••••••••'}</code><div className="secret-actions"><button type="button" className="compact-action" onClick={() => setVisible((current) => !current)}>{visible ? t.hideSecret : t.showSecret}</button><button type="button" className="compact-action" onClick={() => void copy()}>{copied ? t.copied : t.copySecret}</button></div><div className="dialog-actions"><button type="button" className="primary-action" onClick={close}>{t.close}</button></div></div></Dialog>;
}

function MapDisplayPanel({ value, locale, busy, mutate }: { value: MapSettings; locale: AdminLocale; busy: boolean; mutate: Mutate }) {
  const t = adminText[locale];
  const [config, setConfig] = useState(() => ({ google: { ...value.google }, amap: { ...value.amap } }));
  useEffect(() => setConfig({ google: { ...value.google }, amap: { ...value.amap } }), [
    value.google.china, value.google.international, value.amap.china, value.amap.international
  ]);
  const toggle = (provider: 'google' | 'amap', scope: 'china' | 'international', enabled: boolean) =>
    setConfig((current) => ({ ...current, [provider]: { ...current[provider], [scope]: enabled } }));
  return <Panel title={t.mapDisplayTitle}><form className="map-display-form" onSubmit={async (event) => {
    event.preventDefault();
    await mutate('/settings/maps', 'PUT', config, t.mapDisplaySaved);
  }}>
    <div className="map-display-grid">
      <span />
      <b>{t.mapChina}</b>
      <b>{t.mapInternational}</b>
      <strong>{t.googleMap}</strong>
      <label className="switch-field"><input name="googleChina" type="checkbox" checked={config.google.china} onChange={(event) => toggle('google', 'china', event.target.checked)} /><span /></label>
      <label className="switch-field"><input name="googleInternational" type="checkbox" checked={config.google.international} onChange={(event) => toggle('google', 'international', event.target.checked)} /><span /></label>
      <strong>{t.amapMap}</strong>
      <label className="switch-field"><input name="amapChina" type="checkbox" checked={config.amap.china} onChange={(event) => toggle('amap', 'china', event.target.checked)} /><span /></label>
      <label className="switch-field"><input name="amapInternational" type="checkbox" checked={config.amap.international} onChange={(event) => toggle('amap', 'international', event.target.checked)} /><span /></label>
    </div>
    <div className="panel-footer"><p>{t.mapDisplayHint}</p><button className="primary-action" disabled={busy}>{t.saveSettings}</button></div>
  </form></Panel>;
}

function AmapBrowserSummary({ value, locale, busy, mutate, reveal }: { value: AmapBrowserStatus; locale: AdminLocale; busy: boolean; mutate: Mutate; reveal: Reveal }) {
  const t = adminText[locale];
  if (!value.configured) return <div className="credential-summary empty"><p>{t.amapBrowserEmpty}</p><small>{t.amapBrowserSecurity}</small></div>;
  return <div className="credential-summary">
    <div><span>{t.amapBrowserLabel}</span><b>{credentialDisplayLabel(locale, value.label)}</b></div>
    <div><span>{t.amapApiKey}</span><SecretCell mask={value.mask} locale={locale} reveal={reveal} path="/maps/amap-browser/reveal" field="apiKey" /></div>
    <div><span>{t.amapSecurityCode}</span><SecretCell mask={value.securityMask || '••••'} locale={locale} reveal={reveal} path="/maps/amap-browser/reveal" field="securityCode" /></div>
    <div><span>{t.statusLabel}</span><span className={`badge ${value.status}`}>{t.status[value.status as keyof typeof t.status] || value.status}</span></div>
    <div><span>{t.amapLastUsed}</span><b>{dateTime(value.lastUsedAt, locale)}</b></div>
    <div><span>{t.amapUpdated}</span><b>{dateTime(value.updatedAt, locale)}</b></div>
    <div className="credential-summary-actions"><button disabled={busy} onClick={() => void mutate('/maps/amap-browser', 'PUT', { enabled: !value.enabled }, value.enabled ? t.stop : t.enable)}>{value.enabled ? t.stop : t.enable}</button><button className="danger" disabled={busy} onClick={() => {
      if (window.confirm(t.confirmRemoveAmap)) void mutate('/maps/amap-browser', 'DELETE', undefined, t.amapBrowserRemoved);
    }}>{t.remove}</button></div>
    <small>{t.amapBrowserSecurity}</small>
  </div>;
}

function AmapBrowserDialog({ value, locale, busy, mutate, close }: { value: AmapBrowserStatus; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void }) {
  const t = adminText[locale];
  return <Dialog title={t.amapBrowserDialog} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const apiKey = String(values.get('apiKey') || '').trim();
    const securityCode = String(values.get('securityCode') || '').trim();
    const body = {
      label: String(values.get('label') || '').trim(), enabled: values.get('enabled') === 'on',
      ...(apiKey ? { apiKey } : {}), ...(securityCode ? { securityCode } : {})
    };
    const result = await mutate('/maps/amap-browser', value.configured ? 'PUT' : 'POST', body, t.amapBrowserSaved);
    if (result) close();
  }}>
    <label><span>{t.amapBrowserLabel}</span><input name="label" defaultValue={value.label} placeholder={t.amapBrowserPlaceholder} /></label>
    <label><span>{t.amapApiKey}</span><input name="apiKey" type="password" required={!value.configured} autoComplete="new-password" placeholder={value.configured ? t.replaceSecret : ''} /></label>
    <label><span>{t.amapSecurityCode}</span><input name="securityCode" type="password" required={!value.configured} autoComplete="new-password" placeholder={value.configured ? t.replaceSecret : ''} /></label>
    <label className="check"><input name="enabled" type="checkbox" defaultChecked={value.configured ? value.enabled : true} />{t.enable}</label>
    <p className="security-note">{t.amapBrowserSecurity}</p>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}

function SecretCell({ mask, locale, reveal, path, field }: { mask: string; locale: AdminLocale; reveal: Reveal; path: string; field: string }) {
  const t = adminText[locale];
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    setValue(''); setVisible(false); setCopied(false); setError(false);
  }, []);
  useEffect(() => { clear(); }, [clear, locale, mask, path]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); clear(); };
  }, [clear]);
  const toggle = async () => {
    setError(false);
    if (visible) { clear(); return; }
    setBusy(true);
    try {
      const result = await reveal(path);
      const secret = String(result[field] || '');
      if (!secret) throw new Error('EMPTY_SECRET');
      setValue(secret); setVisible(true);
      timer.current = window.setTimeout(clear, 30_000);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setError(true); }
  };
  return <div className="secret-cell"><code>{visible ? value : mask}</code><div className="secret-actions"><button type="button" className="compact-action" disabled={busy} onClick={() => void toggle()}>{busy ? '…' : visible ? t.hideSecret : t.showSecret}</button>{visible && <button type="button" className="compact-action" onClick={() => void copy()}>{copied ? t.copied : t.copySecret}</button>}</div>{error && <small className="field-error">{t.revealFailed}</small>}</div>;
}

const Panel = ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => <section className="admin-panel"><header><h2>{title}</h2>{actions}</header>{children}</section>;
const Dialog = ({ title, close, locale, children }: { title: string; close: () => void; locale: AdminLocale; children: ReactNode }) => <div className="dialog-backdrop" role="presentation"><section className="admin-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" title={adminText[locale].close} aria-label={adminText[locale].close} onClick={close}>×</button></header>{children}</section></div>;
const Metric = ({ label, value }: { label: string; value: string }) => <div className="metric"><span>{label}</span><b>{value}</b></div>;
const scopeLabel = (scope: string, locale: AdminLocale): string => ({ read: locale === 'zh-CN' ? '读取' : 'Read', generate: locale === 'zh-CN' ? '生成' : 'Generate', '*': locale === 'zh-CN' ? '全部' : 'All' } as Record<string, string>)[scope] || scope;
const CoverageTable = ({ values, open, locale }: { values: CoverageNode[]; open: (value: CoverageNode) => void; locale: AdminLocale }) => { const t = adminText[locale]; return <div className="table-scroll"><table><thead><tr><th>{t.region}</th><th>{t.level}</th><th>{t.available}</th><th>{t.residential}</th><th>{t.ordinary}</th><th>{t.children}</th><th>{t.updated}</th></tr></thead><tbody>{values.map((item) => <tr key={item.key}><td><button className="drill-button" disabled={!item.childCount} title={!item.childCount ? t.noSubregions : undefined} onClick={() => open(item)}>{coverageRegionName(item, locale)}</button>{!item.totalCount && <span className="coverage-empty-tag">{t.noAddressData}</span>}</td><td>{coverageLevelName(item, locale)}</td><td>{item.totalCount.toLocaleString()}</td><td>{item.residentialCount.toLocaleString()}</td><td>{item.ordinaryCount.toLocaleString()}</td><td>{item.childCount.toLocaleString()}</td><td>{dateTime(item.updatedAt, locale)}</td></tr>)}</tbody></table>{!values.length && <p className="admin-empty">{t.noSubregions}</p>}</div>; };
const CredentialTable = ({ values, locale, reveal, actions }: { values: Credential[]; locale: AdminLocale; reveal: Reveal; actions?: (value: Credential) => ReactNode }) => {
  const t = adminText[locale];
  return <div className="table-scroll"><table><thead><tr><th>{t.provider}</th><th>{t.name}</th><th>{t.key}</th><th>{t.statusLabel}</th><th>{t.quotaUsage}</th><th>{t.lastSuccess}</th>{actions && <th>{t.actions}</th>}</tr></thead><tbody>{values.map((item) => <tr key={item.id}>
    <td>{providerLabel(locale, item.provider)}</td><td>{credentialDisplayLabel(locale, item.label)}</td>
    <td><SecretCell mask={item.mask} locale={locale} reveal={reveal} path={`/providers/${item.id}/reveal`} field="secret" /></td>
    <td><span className={`badge ${item.status}`}>{t.status[item.status as keyof typeof t.status] || item.status}</span>{item.expiresAt && <small> · {dateTime(item.expiresAt, locale)}</small>}</td>
    <td><div className="quota-cell"><strong>{item.quotaUsed.toLocaleString()} / {item.quotaLimit.toLocaleString()}</strong><small>{item.quotaPeriod === 'month' ? t.quotaMonth : t.quotaDay} · {item.quotaRemaining.toLocaleString()} {t.quotaRemaining}</small><small>{item.quotaUsageSource === 'provider' ? t.quotaProvider : t.quotaLocal} · {t.quotaReset} {dateTime(item.quotaResetAt, locale)}</small></div></td>
    <td>{dateTime(item.lastSuccessAt, locale)}</td>{actions && <td className="row-actions">{actions(item)}</td>}
  </tr>)}</tbody></table>{!values.length && <p className="admin-empty">{t.noKeys}</p>}</div>;
};
const AreaCoverageTable = ({ values, locale }: { values: Array<Record<string, unknown>>; locale: AdminLocale }) => { const t = adminText[locale]; return <div className="table-scroll"><table><thead><tr><th>{t.province}</th><th>{t.city}</th><th>{t.district}</th><th>{t.currentCommunities}</th><th>{t.target}</th><th>{t.statusLabel}</th></tr></thead><tbody>{values.map((item, index) => { const current = Number(item.current_count || 0); const target = Number(item.target_count || 10); return <tr key={`${String(item.city)}-${String(item.district)}-${index}`}><td>{String(item.province)}</td><td>{String(item.city)}</td><td>{String(item.district)}</td><td>{current.toLocaleString()}</td><td>{target.toLocaleString()}</td><td><span className={`badge ${current >= target ? 'succeeded' : ''}`}>{current >= target ? t.covered : t.pending}</span></td></tr>; })}</tbody></table>{!values.length && <p className="admin-empty">{t.noAreas}</p>}</div>; };
const TokenTable = ({ values, locale, reveal, edit, revoke }: { values: ApiTokenView[]; locale: AdminLocale; reveal: Reveal; edit: (value: ApiTokenView) => void; revoke: (id: string) => void }) => { const t = adminText[locale]; return <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.tokenValue}</th><th>{t.scopes}</th><th>{t.perMinute}</th><th>{t.expires}</th><th>{t.actions}</th></tr></thead><tbody>{values.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.token_revealable ? <SecretCell mask={item.token_mask} locale={locale} reveal={reveal} path={`/tokens/${item.id}/reveal`} field="token" /> : <span className="token-unavailable">{t.tokenUnavailable}</span>}</td><td>{item.scopes.map((scope) => scopeLabel(String(scope), locale)).join(locale === 'zh-CN' ? '、' : ', ')}</td><td>{item.rate_limit_per_minute.toLocaleString()}</td><td>{item.expires_at ? dateTime(item.expires_at, locale) : t.neverExpires}</td><td className="row-actions"><button type="button" disabled={Boolean(item.revoked_at)} onClick={() => edit(item)}>{t.edit}</button><button type="button" className="danger" disabled={Boolean(item.revoked_at)} onClick={() => revoke(item.id)}>{item.revoked_at ? t.revoked : t.revoke}</button></td></tr>)}</tbody></table>{!values.length && <p className="admin-empty">{t.noTokens}</p>}</div>; };
const fieldLabels: Record<AdminLocale, Record<string, string>> = {
  'zh-CN': { id: '编号', provider: '平台', name: '名称', total: '总数', city: '城市', district: '区县', province: '省级', status: '状态', kind: '任务类型', error_code: '错误代码', error_message: '错误信息', created_at: '创建时间', started_at: '开始时间', completed_at: '完成时间', updated_at: '更新时间', target: '目标', progress: '进度' },
  en: { id: 'ID', provider: 'Provider', name: 'Name', total: 'Total', city: 'City', district: 'District', province: 'Province', status: 'Status', kind: 'Task type', error_code: 'Error code', error_message: 'Error message', created_at: 'Created', started_at: 'Started', completed_at: 'Completed', updated_at: 'Updated', target: 'Target', progress: 'Progress' }
};
const JsonTable = ({ values, locale }: { values: Array<Record<string, unknown>>; locale: AdminLocale }) => { const t = adminText[locale]; const keys = [...new Set(values.flatMap((value) => Object.keys(value)))]; const display = (value: unknown): string => { if (typeof value === 'string' && value in t.status) return t.status[value as keyof typeof t.status]; if (typeof value === 'object' && value !== null) return JSON.stringify(value); return String(value ?? '-'); }; return <div className="table-scroll"><table><thead><tr>{keys.map((key) => <th key={key}>{fieldLabels[locale][key] || key}</th>)}</tr></thead><tbody>{values.map((value, index) => <tr key={index}>{keys.map((key) => <td key={key}>{display(value[key])}</td>)}</tr>)}</tbody></table>{!values.length && <p className="admin-empty">{t.noRecords}</p>}</div>; };
