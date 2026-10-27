import { t, getLocale, fmtNum } from './i18n.js';

// Number, size and date formatting. Sizes use 1024-based units, labelled like Windows and most Linux file managers do (GB, TB).
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytesParts(b, digits) {
  b = Math.max(0, b || 0);
  let u = 0;
  while (b >= 1024 && u < UNITS.length - 1) { b /= 1024; u++; }
  let d = u === 0 ? 0 : digits;
  if (d === undefined) d = u >= 4 ? 2 : b >= 100 ? 0 : 1;
  return { num: b.toFixed(d), unit: UNITS[u] };
}

// Decimal separator of the current language ("1.5" → "1,5").
const localNum = (str) => (str.includes('.') ? str.replace('.', fmtNum(1.1)[1]) : str);

export function fmtBytes(b, digits) {
  const p = bytesParts(b, digits);
  return `${localNum(p.num)} ${p.unit}`;
}

// Same unit as `ref`, e.g. "381.2 / 476 GB".
export function fmtPair(a, total) {
  const p = bytesParts(total);
  const div = 1024 ** UNITS.indexOf(p.unit);
  return localNum(`${(a / div).toFixed(p.unit === 'TB' ? 2 : 1).replace(/\.0+$/, '')} / ${p.num.replace(/\.0+$/, '')} ${p.unit}`);
}

export const fmtCount = (n) => fmtNum(Math.round(n));

export function fmtShort(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function fmtPct(part, whole, digits = 1) {
  if (!whole) return '0%';
  return (part / whole * 100).toFixed(digits) + '%';
}

export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtEta(sec) {
  if (!isFinite(sec) || sec < 0) return t('Estimating time left…');
  if (sec < 5) return t('Almost done…');
  if (sec < 60) return t('About {n, plural, one {# second} other {# seconds}} left', { n: Math.round(sec / 5) * 5 || 5 });
  const m = Math.round(sec / 60);
  return m === 1 ? t('About a minute left') : t('About {n} minutes left', { n: m });
}

const dateFmt = (opts) => new Intl.DateTimeFormat(getLocale(), opts);

export function fmtWhen(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return t('Today {time}', { time: dateFmt({ hour: '2-digit', minute: '2-digit' }).format(d) });
  if (diff === 1) return t('Yesterday');
  if (d.getFullYear() === now.getFullYear()) return dateFmt({ month: 'short', day: 'numeric' }).format(d);
  return dateFmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

export function fmtAgo(unixSec) {
  if (!unixSec) return t('a while ago');
  const days = (Date.now() / 1000 - unixSec) / 86400;
  if (days < 1) return t('today');
  if (days < 2) return t('yesterday');
  if (days < 14) return t('{n, plural, one {# day} other {# days}} ago', { n: Math.floor(days) });
  if (days < 60) return t('{n, plural, one {# week} other {# weeks}} ago', { n: Math.floor(days / 7) });
  if (days < 365) return t('{n, plural, one {# month} other {# months}} ago', { n: Math.floor(days / 30) });
  return t('{n, plural, one {# year} other {# years}} ago', { n: Math.floor(days / 365) });
}

export function fmtMonth(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getFullYear() === new Date().getFullYear() ? dateFmt({ month: 'long' }).format(d) : dateFmt({ month: 'long', year: 'numeric' }).format(d);
}
// "C:\Users\alex\AppData\Local\Packages\…\LocalCache\Roaming\cache_0042.bin"
export function middleEllipsis(p, max = 96) {
  if (!p || p.length <= max) return p || '';
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep);
  let head = parts.slice(0, 5), tail = parts.slice(-3);
  let s = [...head, '…', ...tail].join(sep);
  while (s.length > max && head.length > 2) { head = head.slice(0, -1); s = [...head, '…', ...tail].join(sep); }
  return s.length > max ? '…' + p.slice(-(max - 1)) : s;
}
