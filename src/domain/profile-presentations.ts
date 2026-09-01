import {
  base, de, en, es, Faker, fr, ja, ko, pt_BR, zh_CN, zh_TW, type LocaleDefinition
} from '@faker-js/faker';
import type {
  GeneratedExtensions, GeneratedProfilePresentation, Locale
} from './types';

const fakerLocales: Record<Locale, LocaleDefinition> = {
  en, 'zh-CN': zh_CN, 'zh-TW': zh_TW, ja, ko, de, fr, es, pt: pt_BR
};

const accountTypeNames: Record<Locale, Record<string, string>> = {
  en: { 'Checking Account': 'Checking Account', 'Everyday Account': 'Everyday Account', 'Current Account': 'Current Account', 'Savings Account': 'Savings Account' },
  'zh-CN': { 'Checking Account': '支票账户', 'Everyday Account': '日常账户', 'Current Account': '活期账户', 'Savings Account': '储蓄账户' },
  'zh-TW': { 'Checking Account': '支票帳戶', 'Everyday Account': '日常帳戶', 'Current Account': '活期帳戶', 'Savings Account': '儲蓄帳戶' },
  ja: { 'Checking Account': '当座預金口座', 'Everyday Account': '普通預金口座', 'Current Account': '当座口座', 'Savings Account': '貯蓄預金口座' },
  ko: { 'Checking Account': '당좌예금 계좌', 'Everyday Account': '입출금 계좌', 'Current Account': '보통예금 계좌', 'Savings Account': '저축예금 계좌' },
  de: { 'Checking Account': 'Girokonto', 'Everyday Account': 'Alltagskonto', 'Current Account': 'Kontokorrentkonto', 'Savings Account': 'Sparkonto' },
  fr: { 'Checking Account': 'Compte courant', 'Everyday Account': 'Compte quotidien', 'Current Account': 'Compte à vue', 'Savings Account': 'Compte épargne' },
  es: { 'Checking Account': 'Cuenta corriente', 'Everyday Account': 'Cuenta diaria', 'Current Account': 'Cuenta a la vista', 'Savings Account': 'Cuenta de ahorros' },
  pt: { 'Checking Account': 'Conta corrente', 'Everyday Account': 'Conta do dia a dia', 'Current Account': 'Conta à ordem', 'Savings Account': 'Conta poupança' }
};

const transactionPrefixes: Record<Locale, string> = {
  en: 'CARD PURCHASE', 'zh-CN': '银行卡消费', 'zh-TW': '信用卡消費', ja: 'カード利用', ko: '카드 결제',
  de: 'KARTENZAHLUNG', fr: 'PAIEMENT PAR CARTE', es: 'COMPRA CON TARJETA', pt: 'COMPRA COM CARTÃO'
};

const consultingTemplates: Record<Locale, (name: string) => string> = {
  en: (name) => `${name} Consulting`, 'zh-CN': (name) => `${name}咨询`, 'zh-TW': (name) => `${name}顧問`,
  ja: (name) => `${name}コンサルティング`, ko: (name) => `${name} 컨설팅`, de: (name) => `${name} Beratung`,
  fr: (name) => `Conseil ${name}`, es: (name) => `Consultoría ${name}`, pt: (name) => `Consultoria ${name}`
};

const petNames: Record<Locale, readonly string[]> = {
  en: ['Milo', 'Luna', 'Charlie', 'Daisy'], 'zh-CN': ['豆豆', '团团', '乐乐', '小白'],
  'zh-TW': ['豆豆', '圓圓', '樂樂', '小白'], ja: ['モモ', 'ハナ', 'ソラ', 'ココ'],
  ko: ['초롱이', '보리', '콩이', '하늘이'], de: ['Luna', 'Bella', 'Milo', 'Lotti'],
  fr: ['Luna', 'Nala', 'Rio', 'Plume'], es: ['Luna', 'Nala', 'Coco', 'Kira'], pt: ['Luna', 'Mel', 'Nina', 'Theo']
};

const accountTypeFrom = (value: string): string =>
  Object.keys(accountTypeNames.en).find((accountType) => value.endsWith(` · ${accountType}`)) || 'Current Account';

const fullNameFor = (locale: Locale, gender: 'female' | 'male', faker: Faker): string => {
  const firstName = faker.person.firstName(gender);
  const lastName = faker.person.lastName(gender);
  if (locale === 'zh-CN' || locale === 'zh-TW' || locale === 'ko') return `${lastName}${firstName}`;
  if (locale === 'ja') return `${lastName} ${firstName}`;
  return `${firstName} ${lastName}`;
};

const answerFor = (
  locale: Locale,
  question: string,
  faker: Faker,
  seed: number
): string => {
  if (question === 'What was the name of your first pet?') return petNames[locale][seed % petNames[locale].length];
  if (question === 'What was your childhood nickname?') return faker.person.firstName();
  if (question === 'In what city did your parents meet?') return faker.location.city();
  return faker.person.lastName();
};

export const generateProfilePresentations = (
  requestSeed: number,
  gender: 'female' | 'male',
  extensions: GeneratedExtensions
): Record<Locale, GeneratedProfilePresentation> => Object.fromEntries(
  (Object.keys(fakerLocales) as Locale[]).map((locale, localeIndex) => {
    const faker = new Faker({ locale: [fakerLocales[locale], en, base] });
    faker.seed(requestSeed);
    const fullName = fullNameFor(locale, gender, faker);
    const active = extensions.employment.employmentStatus === 'employed'
      || extensions.employment.employmentStatus === 'self-employed';
    const company = active
      ? extensions.employment.employmentStatus === 'self-employed'
        ? consultingTemplates[locale](fullName)
        : faker.company.name()
      : undefined;
    const accountType = accountTypeFrom(extensions.finance.accountDisplayName);
    const merchant = faker.company.name().replace(/\s+/gu, ' ').trim().slice(0, 64);
    return [locale, {
      fullName,
      ...(company ? { company } : {}),
      accountDisplayName: `${fullName} · ${accountTypeNames[locale][accountType]}`,
      transactionDescription: `${transactionPrefixes[locale]} · ${merchant}`,
      securityAnswer: answerFor(locale, extensions.internet.securityQuestion, faker, requestSeed + localeIndex)
    }];
  })
) as Record<Locale, GeneratedProfilePresentation>;
