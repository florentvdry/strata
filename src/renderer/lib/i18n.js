// Translations. The English text is the key: t('Scan options') returns the English when a language has no entry for it,
// so a missing translation never leaves a blank. Catalogs live in locales/<code>.js and are loaded on demand.
//
//   t('Scan options')
//   t('Scanning {root}', { root })
//   t('{n, plural, one {# file} other {# files}}', { n })     (# is n, formatted for the language)
//
// Plural categories (zero one two few many other) follow the language's CLDR rules through Intl.PluralRules.

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'zh', name: '简体中文' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'es', name: 'Español' },
  { code: 'ar', name: 'العربية', rtl: true },
  { code: 'fr', name: 'Français' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'it', name: 'Italiano' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'id', name: 'Bahasa Indonesia' },
];

let locale = 'en';
let messages = {};
let plurals = new Intl.PluralRules('en');
let numbers = new Intl.NumberFormat('en');

export const getLocale = () => locale;

// 'auto' (or anything unknown) follows the system language: the first of navigator.languages that we ship.
export function resolveLocale(pref) {
  const have = (c) => LANGUAGES.some((l) => l.code === c);
  if (have(pref)) return pref;
  for (const tag of (typeof navigator !== 'undefined' && navigator.languages) || ['en']) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (have(base)) return base;
  }
  return 'en';
}

export async function setLocale(pref) {
  const code = resolveLocale(pref);
  let next = {};
  if (code !== 'en') {
    try { next = (await import(`../locales/${code}.js`)).default; } catch (e) { console.error(`No translations for ${code}`, e); }
  }
  locale = code;
  messages = next;
  plurals = new Intl.PluralRules(code);
  numbers = new Intl.NumberFormat(code);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code;
    document.documentElement.dir = LANGUAGES.find((l) => l.code === code).rtl ? 'rtl' : 'ltr';
  }
  return code;
}

export const fmtNum = (n) => numbers.format(n);

// Finds the } matching the { at `open`.
function close(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function render(s, p) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') { out += s[i]; continue; }
    const end = close(s, i);
    if (end < 0) { out += s.slice(i); break; }
    const body = s.slice(i + 1, end);
    const comma = body.indexOf(',');
    if (comma < 0) {
      out += body in p ? p[body] : `{${body}}`;
    } else {
      const name = body.slice(0, comma).trim();
      const rest = body.slice(comma + 1).replace(/^\s*plural\s*,/, '');
      const n = Number(p[name]);
      const forms = {};
      for (let j = 0; j < rest.length; j++) {
        const open = rest.indexOf('{', j);
        if (open < 0) break;
        const stop = close(rest, open);
        if (stop < 0) break;
        forms[rest.slice(j, open).trim()] = rest.slice(open + 1, stop);
        j = stop;
      }
      const form = forms[`=${n}`] ?? forms[plurals.select(n)] ?? forms.other ?? '';
      out += render(form.replace(/#/g, numbers.format(n)), p);
    }
    i = end;
  }
  return out;
}

export function t(key, params) {
  const s = messages[key] ?? key;
  return params || s.includes('{') ? render(s, params || {}) : s;
}
