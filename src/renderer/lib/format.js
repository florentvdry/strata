// Number, size and date formatting. Sizes use 1024-based units, labelled like Windows does (GB, TB).
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytesParts(b, digits) {
  b = Math.max(0, b || 0);
  let u = 0;
  while (b >= 1024 && u < UNITS.length - 1) { b /= 1024; u++; }
  let d = u === 0 ? 0 : digits;
  if (d === undefined) d = u >= 4 ? 2 : b >= 100 ? 0 : 1;
  return { num: b.toFixed(d), unit: UNITS[u] };
}

export function fmtBytes(b, digits) {
  const p = bytesParts(b, digits);
  return `${p.num} ${p.unit}`;
}

// Same unit as `ref`, e.g. "381.2 / 476 GB".
export function fmtPair(a, total) {
  const p = bytesParts(total);
  const div = 1024 ** UNITS.indexOf(p.unit);
  return `${(a / div).toFixed(p.unit === 'TB' ? 2 : 1).replace(/\.0+$/, '')} / ${p.num.replace(/\.0+$/, '')} ${p.unit}`;
}

export const fmtCount = (n) => Math.round(n).toLocaleString('en-US');

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
  if (!isFinite(sec) || sec < 0) return 'Estimating time left…';
  if (sec < 5) return 'Almost done…';
  if (sec < 60) return `About ${Math.round(sec / 5) * 5 || 5} seconds left`;
  const m = Math.round(sec / 60);
  return m === 1 ? 'About a minute left' : `About ${m} minutes left`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function fmtWhen(ms) {
  const d = new Date(ms), now = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function fmtAgo(unixSec) {
  if (!unixSec) return 'a while ago';
  const days = (Date.now() / 1000 - unixSec) / 86400;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return `${Math.floor(days)} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const y = Math.floor(days / 365);
  return y === 1 ? 'a year ago' : `${y} years ago`;
}

export function fmtMonth(unixSec) {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() ? LONG_MONTHS[d.getMonth()] : `${LONG_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// "C:\Users\alex\AppData\Local\Packages\…\LocalCache\Roaming\cache_0042.bin"
export function middleEllipsis(p, max = 96) {
  if (!p || p.length <= max) return p || '';
  const parts = p.split('\\');
  let head = parts.slice(0, 5), tail = parts.slice(-3);
  let s = [...head, '…', ...tail].join('\\');
  while (s.length > max && head.length > 2) { head = head.slice(0, -1); s = [...head, '…', ...tail].join('\\'); }
  return s.length > max ? '…' + p.slice(-(max - 1)) : s;
}

export function plural(n, one, many) { return `${fmtCount(n)} ${n === 1 ? one : (many || one + 's')}`; }
