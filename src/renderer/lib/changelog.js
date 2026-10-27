// Reads CHANGELOG.md (Keep a Changelog) and the release notes Strata shows. No imports: the release script
// (scripts/changelog.js) loads this file too, so the app and the tooling parse the format the same way.

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Internal'];

/** "0.2.0-beta.1" → [0, 2, 0, ['beta', 1]] */
function parts(v) {
  const [core, pre] = String(v).replace(/^v/, '').split('-', 2);
  return [core.split('.').map((n) => parseInt(n, 10) || 0), pre ? pre.split('.').map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : x)) : null];
}

/** Semantic-version order: negative when a < b. A pre-release is older than its release. */
export function compareVersions(a, b) {
  const [ca, pa] = parts(a), [cb, pb] = parts(b);
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] === pb[i]) continue;
    if (typeof pa[i] === 'number' && typeof pb[i] === 'number') return pa[i] - pb[i];
    if (typeof pa[i] === 'number') return -1;
    if (typeof pb[i] === 'number') return 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (v) => String(v).includes('-');

/**
 * { unreleased, releases } from the text of CHANGELOG.md. An entry is
 * { version, date, prerelease, summary, sections: [{ title, items: [{ text, children: [text] }] }] }.
 */
export function parseChangelog(md) {
  const entries = [];
  let entry = null, section = null, item = null, intro = [];
  const flushIntro = () => { if (entry && !section) entry.summary = intro.join(' ').trim(); intro = []; };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/.exec(line))) {
      flushIntro();
      entry = { version: m[1], date: m[2] || null, prerelease: isPrerelease(m[1]), summary: '', sections: [] };
      entries.push(entry); section = null; item = null;
    } else if (/^## /.test(line)) {
      flushIntro(); entry = null; section = null; item = null;
    } else if (!entry) {
      continue;
    } else if ((m = /^### (.+)$/.exec(line))) {
      flushIntro();
      section = { title: m[1].trim(), items: [] };
      entry.sections.push(section); item = null;
    } else if ((m = /^- (.*)$/.exec(line)) && section) {
      item = { text: m[1], children: [] };
      section.items.push(item);
    } else if ((m = /^\s+[-*] (.*)$/.exec(line)) && item) {
      item.children.push(m[1]);
    } else if (/^\s+\S/.test(line) && item) {
      if (item.children.length) item.children[item.children.length - 1] += ` ${line.trim()}`;
      else item.text += ` ${line.trim()}`;
    } else if (line.trim() && !section && !/^\[[^\]]+\]: /.test(line)) {
      intro.push(line.trim());
    }
  }
  flushIntro();
  const unreleased = entries.find((e) => e.version.toLowerCase() === 'unreleased') || null;
  const releases = entries.filter((e) => e !== unreleased);
  return { unreleased, releases };
}

/** What people reading release notes care about: no "Internal" section, no empty ones. */
export function publicEntry(entry) {
  return { ...entry, sections: entry.sections.filter((s) => s.title !== 'Internal' && s.items.length) };
}

export const isEmpty = (entry) => !entry.summary && !entry.sections.some((s) => s.items.length);

/** Markdown for one version: GitHub release body, update manifest notes. */
export function renderNotes(entry, { internal = false } = {}) {
  const e = internal ? entry : publicEntry(entry);
  const out = [];
  if (e.summary) out.push(e.summary, '');
  for (const s of e.sections) {
    out.push(`### ${s.title}`, '');
    for (const it of s.items) {
      out.push(`- ${it.text}`);
      for (const c of it.children) out.push(`  - ${c}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/** Parses notes written by renderNotes (the text in an update manifest). */
export function parseNotes(md) {
  const { releases } = parseChangelog(`## [x]\n${md || ''}`);
  return releases[0] || { version: '', date: null, prerelease: false, summary: '', sections: [] };
}

/** Released versions after `from` up to `to`, newest first (for "What's new" after an update). */
export function between(releases, from, to) {
  return releases.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0).sort((a, b) => compareVersions(b.version, a.version));
}
