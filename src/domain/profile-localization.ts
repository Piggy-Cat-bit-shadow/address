import { countryProfileLanguage, profileLabelForLanguage } from './profile-native-labels';
import type { CountryCode, Locale, ProfileLanguage } from './types';

export const profileLanguageNames: Record<Locale, string> = {
  en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어',
  de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português'
};

export const profileLanguageControlText: Record<Locale, { label: string; native: string; other: string }> = {
  en: { label: 'Profile language', native: 'Original language', other: 'Other languages' },
  'zh-CN': { label: '资料语言', native: '原始国家语言', other: '其他语言' },
  'zh-TW': { label: '資料語言', native: '原始國家語言', other: '其他語言' },
  ja: { label: 'プロフィール言語', native: '元の国の言語', other: 'その他の言語' },
  ko: { label: '프로필 언어', native: '원래 국가 언어', other: '기타 언어' },
  de: { label: 'Profilsprache', native: 'Ursprüngliche Landessprache', other: 'Weitere Sprachen' },
  fr: { label: 'Langue du profil', native: 'Langue d’origine du pays', other: 'Autres langues' },
  es: { label: 'Idioma del perfil', native: 'Idioma original del país', other: 'Otros idiomas' },
  pt: { label: 'Idioma do perfil', native: 'Idioma original do país', other: 'Outros idiomas' }
};

const workKeys = [
  'Customer Service Representative', 'Retail Store Supervisor', 'Warehouse Coordinator',
  'Administrative Assistant', 'Maintenance Technician', 'Network Support Specialist',
  'Systems Support Technician', 'Accounting Technician', 'Payroll Specialist', 'Paralegal',
  'Legal Operations Specialist', 'Software Engineer', 'Civil Engineer', 'Quality Engineer',
  'Financial Analyst', 'Management Accountant', 'Human Resources Specialist',
  'Talent Acquisition Specialist', 'Marketing Specialist', 'Communications Specialist',
  'Product Manager', 'Business Intelligence Manager', 'Data Scientist',
  'Clinical Research Coordinator', 'Urban Planner', 'Research Scientist',
  'University Lecturer', 'Clinical Psychologist', 'Customer Operations', 'Operations',
  'Information Technology', 'Finance', 'Legal', 'Engineering', 'People Operations',
  'Marketing', 'Product', 'Research', 'Owner'
] as const;

const workTranslations: Record<Exclude<Locale, 'en' | 'zh-CN'>, readonly string[]> = {
  'zh-TW': [
    '客戶服務代表', '零售店主管', '倉儲協調員', '行政助理', '維修技術員', '網路支援專員',
    '系統支援技術員', '會計技術員', '薪資專員', '律師助理', '法務營運專員', '軟體工程師',
    '土木工程師', '品質工程師', '財務分析師', '管理會計師', '人力資源專員', '人才招募專員',
    '行銷專員', '傳播專員', '產品經理', '商業智慧經理', '資料科學家', '臨床研究協調員',
    '都市規劃師', '研究科學家', '大學講師', '臨床心理師', '客戶營運', '營運', '資訊科技',
    '財務', '法務', '工程', '人力資源營運', '行銷', '產品', '研究', '負責人'
  ],
  ja: [
    'カスタマーサービス担当者', '小売店スーパーバイザー', '倉庫コーディネーター', '管理アシスタント', '保守技術者', 'ネットワークサポート担当者',
    'システムサポート技術者', '会計技術者', '給与担当者', 'パラリーガル', '法務オペレーション担当者', 'ソフトウェアエンジニア',
    '土木技術者', '品質エンジニア', '財務アナリスト', '管理会計士', '人事担当者', '採用担当者',
    'マーケティング担当者', '広報担当者', 'プロダクトマネージャー', 'ビジネスインテリジェンスマネージャー', 'データサイエンティスト', '臨床研究コーディネーター',
    '都市計画家', '研究科学者', '大学講師', '臨床心理士', 'カスタマーオペレーション', 'オペレーション', '情報技術',
    '財務', '法務', 'エンジニアリング', '人事オペレーション', 'マーケティング', 'プロダクト', '研究', '責任者'
  ],
  ko: [
    '고객 서비스 담당자', '소매점 관리자', '창고 코디네이터', '행정 보조원', '유지보수 기술자', '네트워크 지원 전문가',
    '시스템 지원 기술자', '회계 기술자', '급여 전문가', '법률 보조원', '법무 운영 전문가', '소프트웨어 엔지니어',
    '토목 엔지니어', '품질 엔지니어', '재무 분석가', '관리 회계사', '인사 전문가', '인재 채용 전문가',
    '마케팅 전문가', '커뮤니케이션 전문가', '제품 관리자', '비즈니스 인텔리전스 관리자', '데이터 과학자', '임상 연구 코디네이터',
    '도시 계획가', '연구 과학자', '대학 강사', '임상 심리학자', '고객 운영', '운영', '정보 기술',
    '재무', '법무', '엔지니어링', '인사 운영', '마케팅', '제품', '연구', '책임자'
  ],
  de: [
    'Kundendienstmitarbeiter', 'Einzelhandelsleiter', 'Lagerkoordinator', 'Verwaltungsassistent', 'Wartungstechniker', 'Netzwerksupport-Spezialist',
    'Systemsupport-Techniker', 'Buchhaltungstechniker', 'Lohnbuchhalter', 'Rechtsanwaltsfachangestellter', 'Spezialist für Rechtsabläufe', 'Softwareentwickler',
    'Bauingenieur', 'Qualitätsingenieur', 'Finanzanalyst', 'Management Accountant', 'Personalfachkraft', 'Recruiting-Spezialist',
    'Marketingspezialist', 'Kommunikationsspezialist', 'Produktmanager', 'Business-Intelligence-Manager', 'Datenwissenschaftler', 'Koordinator für klinische Forschung',
    'Stadtplaner', 'Forschungswissenschaftler', 'Hochschuldozent', 'Klinischer Psychologe', 'Kundenservice', 'Betrieb', 'Informationstechnologie',
    'Finanzen', 'Recht', 'Technik', 'Personalwesen', 'Marketing', 'Produkt', 'Forschung', 'Inhaber'
  ],
  fr: [
    'Conseiller clientèle', 'Responsable de magasin', 'Coordinateur d’entrepôt', 'Assistant administratif', 'Technicien de maintenance', 'Spécialiste du support réseau',
    'Technicien support systèmes', 'Technicien comptable', 'Gestionnaire de paie', 'Assistant juridique', 'Spécialiste des opérations juridiques', 'Ingénieur logiciel',
    'Ingénieur civil', 'Ingénieur qualité', 'Analyste financier', 'Comptable de gestion', 'Spécialiste des ressources humaines', 'Spécialiste du recrutement',
    'Spécialiste marketing', 'Spécialiste de la communication', 'Chef de produit', 'Responsable de l’informatique décisionnelle', 'Data scientist', 'Coordinateur de recherche clinique',
    'Urbaniste', 'Chercheur scientifique', 'Enseignant universitaire', 'Psychologue clinicien', 'Opérations clients', 'Opérations', 'Technologies de l’information',
    'Finance', 'Juridique', 'Ingénierie', 'Ressources humaines', 'Marketing', 'Produit', 'Recherche', 'Propriétaire'
  ],
  es: [
    'Representante de atención al cliente', 'Supervisor de tienda', 'Coordinador de almacén', 'Asistente administrativo', 'Técnico de mantenimiento', 'Especialista en soporte de redes',
    'Técnico de soporte de sistemas', 'Técnico contable', 'Especialista en nóminas', 'Asistente jurídico', 'Especialista en operaciones jurídicas', 'Ingeniero de software',
    'Ingeniero civil', 'Ingeniero de calidad', 'Analista financiero', 'Contable de gestión', 'Especialista en recursos humanos', 'Especialista en selección de personal',
    'Especialista en marketing', 'Especialista en comunicación', 'Gerente de producto', 'Gerente de inteligencia empresarial', 'Científico de datos', 'Coordinador de investigación clínica',
    'Urbanista', 'Científico investigador', 'Profesor universitario', 'Psicólogo clínico', 'Operaciones de clientes', 'Operaciones', 'Tecnología de la información',
    'Finanzas', 'Asuntos jurídicos', 'Ingeniería', 'Recursos humanos', 'Marketing', 'Producto', 'Investigación', 'Propietario'
  ],
  pt: [
    'Representante de atendimento ao cliente', 'Supervisor de loja', 'Coordenador de armazém', 'Assistente administrativo', 'Técnico de manutenção', 'Especialista em suporte de rede',
    'Técnico de suporte de sistemas', 'Técnico de contabilidade', 'Especialista em folha de pagamento', 'Assistente jurídico', 'Especialista em operações jurídicas', 'Engenheiro de software',
    'Engenheiro civil', 'Engenheiro de qualidade', 'Analista financeiro', 'Contabilista de gestão', 'Especialista em recursos humanos', 'Especialista em recrutamento',
    'Especialista em marketing', 'Especialista em comunicação', 'Gerente de produto', 'Gerente de inteligência de negócios', 'Cientista de dados', 'Coordenador de pesquisa clínica',
    'Urbanista', 'Cientista pesquisador', 'Professor universitário', 'Psicólogo clínico', 'Operações de clientes', 'Operações', 'Tecnologia da informação',
    'Finanças', 'Jurídico', 'Engenharia', 'Recursos humanos', 'Marketing', 'Produto', 'Pesquisa', 'Proprietário'
  ]
};

const workLabelMaps = Object.fromEntries(Object.entries(workTranslations).map(([language, values]) => [
  language, Object.fromEntries(workKeys.map((key, index) => [key, values[index]]))
])) as Record<Exclude<Locale, 'en' | 'zh-CN'>, Record<string, string>>;

const traditionalLabels: Record<string, string> = {
  secondary: '中學', associate: '專科', bachelor: '學士', master: '碩士', doctorate: '博士',
  employed: '在職', 'self-employed': '自僱', student: '學生', 'between-jobs': '待業', retired: '退休',
  mr: '先生', ms: '女士', 'full-time': '全職', 'part-time': '兼職',
  capricorn: '摩羯座', aquarius: '水瓶座', pisces: '雙魚座', aries: '牡羊座', taurus: '金牛座',
  gemini: '雙子座', cancer: '巨蟹座', leo: '獅子座', virgo: '處女座', libra: '天秤座',
  scorpio: '天蠍座', sagittarius: '射手座', 'Checking Account': '支票帳戶',
  'Everyday Account': '日常帳戶', 'Current Account': '活期帳戶', 'Savings Account': '儲蓄帳戶',
  'What was the name of your first pet?': '你的第一隻寵物叫什麼名字？',
  'What was your childhood nickname?': '你小時候的暱稱是什麼？',
  'In what city did your parents meet?': '你的父母在哪個城市相識？',
  "What was your favorite teacher's surname?": '你最喜歡的老師姓什麼？'
};

export const resolvedProfileLocale = (
  language: ProfileLanguage,
  countryCode: CountryCode
): Locale | undefined => {
  if (language !== 'native') return language;
  const native = countryProfileLanguage[countryCode];
  if (native === 'zh') return countryCode === 'TW' || countryCode === 'HK' ? 'zh-TW' : 'zh-CN';
  if (native === 'pt') return 'pt';
  return ['en', 'ja', 'ko', 'de', 'fr', 'es'].includes(native) ? native as Locale : undefined;
};

export const localizedWorkValue = (value: string, language: ProfileLanguage, countryCode: CountryCode): string | undefined => {
  const locale = resolvedProfileLocale(language, countryCode);
  if (!locale || locale === 'en' || locale === 'zh-CN') return undefined;
  const independent = value.startsWith('Independent ');
  const source = independent ? value.slice('Independent '.length) : value;
  const translated = workLabelMaps[locale]?.[source];
  if (!translated) return profileLabelForLanguage(value, locale);
  if (!independent) return translated;
  return ({ 'zh-TW': `獨立${translated}`, ja: `独立${translated}`, ko: `독립 ${translated}`, de: `Selbstständiger ${translated}`,
    fr: `${translated} indépendant`, es: `${translated} independiente`, pt: `${translated} independente` } as Record<string, string>)[locale];
};

export const localizedProfileValue = (value: string, language: ProfileLanguage, countryCode: CountryCode): string | undefined => {
  const work = localizedWorkValue(value, language, countryCode);
  if (work) return work;
  const locale = resolvedProfileLocale(language, countryCode);
  if (!locale || locale === 'en' || locale === 'zh-CN') return undefined;
  if (locale === 'zh-TW') return traditionalLabels[value];
  return profileLabelForLanguage(value, locale);
};
