// What differs between Windows and Linux in paths and wording.
const platform = (typeof window !== 'undefined' && window.strata && window.strata.platform) || 'win32';

export const isWin = platform === 'win32';
export const sep = isWin ? '\\' : '/';
// Paths are case-insensitive on Windows only.
export const fold = isWin ? (s) => s.toLowerCase() : (s) => s;
export const TRASH = isWin ? 'Recycle Bin' : 'Trash';
export const FILE_MANAGER = isWin ? 'Explorer' : 'file manager';

export function joinPath(dir, name) {
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

// Parent folder, or the path itself at a root.
export function parentPath(p) {
  const k = p.lastIndexOf(sep);
  if (k < 0) return p;
  if (!isWin && k === 0) return p.length > 1 ? '/' : p;
  return p.slice(0, k) || p;
}

// "/home/alex" or "C:\Users\alex", without a trailing separator unless it's a root ("/", "C:\").
export function trimSep(p) {
  if (isWin) return p.length > 3 ? p.replace(/\\+$/, '') : p;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// Is `p` the folder `dir` or inside it?
export function isUnderPath(p, dir) {
  const a = fold(trimSep(p)), d = fold(trimSep(dir));
  if (a === d) return true;
  return a.startsWith(d.endsWith(sep) ? d : d + sep);
}
