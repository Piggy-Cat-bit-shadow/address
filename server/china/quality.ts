const navigationTerms = [
  '交叉口', '路口', '附近', '步行', '地铁站', '公交站', '东侧', '西侧', '南侧', '北侧',
  '东面', '西面', '南面', '北面', '正对面'
];

const trailingNavigation = /[（(][^）)]*(?:步行|地铁|公交|入口|出口|\d+\s*米)[）)]\s*$/u;
const premiseNumber = /\d+(?:[-之]\d+)*(?:号|號|弄|巷|院)(?:楼|棟|栋)?/u;
const directionalDistance = /(?:东|西|南|北|东北|东南|西北|西南)\s*\d+\s*米/u;

export const normalizeChinaDeliveryAddress = (value: string): string => {
  let normalized = String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
  while (trailingNavigation.test(normalized)) normalized = normalized.replace(trailingNavigation, '');
  return normalized;
};

export const isChinaDeliveryAddress = (value: string): boolean => {
  const normalized = normalizeChinaDeliveryAddress(value);
  if (!normalized || normalized.length > 160 || !premiseNumber.test(normalized)) return false;
  if (directionalDistance.test(normalized)) return false;
  return !navigationTerms.some((term) => normalized.includes(term));
};

export const chinaDeliveryAddressClause = (alias = 'community'): string => [
  `${alias}.provider_address GLOB '*[0-9]*'`,
  `(${alias}.provider_address LIKE '%号%' OR ${alias}.provider_address LIKE '%號%' OR ${alias}.provider_address LIKE '%弄%' OR ${alias}.provider_address LIKE '%巷%' OR ${alias}.provider_address LIKE '%院%')`,
  ...navigationTerms.map((term) => `${alias}.provider_address NOT LIKE '%${term}%'`),
  `${alias}.provider_address NOT GLOB '*[东南西北][0-9]*米*'`
].join(' AND ');
