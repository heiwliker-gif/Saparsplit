import ru from './locales/ru.json';
import kk from './locales/kk.json';
import en from './locales/en.json';

const dictionaries = { ru, kk, en };
const localeTags = { ru: 'ru-RU', kk: 'kk-KZ', en: 'en-US' };
const languageTags = { ru: 'ru', kk: 'kk', en: 'en' };

function readSavedLanguage() {
  try {
    const saved = localStorage.getItem('ss_language');
    return Object.hasOwn(dictionaries, saved) ? saved : 'ru';
  } catch {
    return 'ru';
  }
}

let activeLanguage = readSavedLanguage();

const counts = {
  ru: {
    account: { one: 'аккаунт', few: 'аккаунта', many: 'аккаунтов' },
    participant: { one: 'участник', few: 'участника', many: 'участников' },
    expense: { one: 'расход', few: 'расхода', many: 'расходов' },
    entry: { one: 'запись', few: 'записи', many: 'записей' },
    person: { one: 'человек', few: 'человека', many: 'человек' },
    place: { one: 'место', few: 'места', many: 'мест' },
  },
  kk: {
    account: { other: 'аккаунт' },
    participant: { other: 'қатысушы' },
    expense: { other: 'шығын' },
    entry: { other: 'жазба' },
    person: { other: 'адам' },
    place: { other: 'орын' },
  },
  en: {
    account: { one: 'account', other: 'accounts' },
    participant: { one: 'participant', other: 'participants' },
    expense: { one: 'expense', other: 'expenses' },
    entry: { one: 'entry', other: 'entries' },
    person: { one: 'person', other: 'people' },
    place: { one: 'place', other: 'places' },
  },
};

export function getLanguage() {
  return activeLanguage;
}

export function setLanguage(language) {
  if (!Object.hasOwn(dictionaries, language)) return activeLanguage;
  activeLanguage = language;
  try { localStorage.setItem('ss_language', language); } catch { /* keep the choice for this session */ }
  if (typeof document !== 'undefined') document.documentElement.lang = languageTags[language];
  return activeLanguage;
}

export function t(key, values = {}) {
  const source = String(key ?? '');
  const translated = dictionaries[activeLanguage]?.[source] ?? ru[source] ?? source;
  return String(translated).replace(/\{(\w+)\}/g, (placeholder, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  ));
}

export function countLabel(kind, amount) {
  const count = Number(amount) || 0;
  const rules = new Intl.PluralRules(localeTags[activeLanguage]);
  const plural = rules.select(count);
  const label = counts[activeLanguage]?.[kind]?.[plural]
    || counts[activeLanguage]?.[kind]?.other
    || counts.en[kind].other;
  return `${new Intl.NumberFormat(localeTags[activeLanguage], { maximumFractionDigits: 0 }).format(count)} ${label}`;
}

export function formatMoney(value, currency = '₸') {
  const amount = Number(value || 0).toLocaleString(localeTags[activeLanguage], { maximumFractionDigits: 2 });
  return `${currency}${currency ? ' ' : ''}${amount}`;
}

export function formatDate(value) {
  if (!value) return t('Дата не указана');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(localeTags[activeLanguage], { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}
