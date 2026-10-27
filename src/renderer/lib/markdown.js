// The little Markdown the release notes use, drawn as Preact nodes (never as HTML strings).
import { html } from './html.js';
import { t } from './i18n.js';

const TOKEN = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/;

/** Bold, *italic*, `code` and [links](url). Links open in the browser, only when they are web links. */
export function inline(text) {
  return String(text).split(TOKEN).map((p, i) => {
    if (!p) return null;
    if (p.startsWith('**')) return html`<b key=${i} style="color: #E6E8EB; font-weight: 600">${p.slice(2, -2)}</b>`;
    if (p.startsWith('*')) return html`<i key=${i}>${p.slice(1, -1)}</i>`;
    if (p.startsWith('`')) return html`<code key=${i} style="font-family: 'Geist Mono', monospace; font-size: 0.92em; padding: 1px 5px; border-radius: 5px; background: #0E1014; border: 1px solid #22262D; color: #C9CED6">${p.slice(1, -1)}</code>`;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
    if (link) {
      const url = link[2];
      if (!/^https?:\/\//.test(url)) return link[1];
      return html`<a key=${i} href=${url} onClick=${(e) => { e.preventDefault(); window.strata.openUrl(url); }}>${link[1]}</a>`;
    }
    return p;
  });
}

// Keep a literal t() per heading so the translation catalogs pick them up.
const SECTION_TITLE = {
  Added: () => t('Added'), Changed: () => t('Changed'), Deprecated: () => t('Deprecated'),
  Removed: () => t('Removed'), Fixed: () => t('Fixed'), Security: () => t('Security'),
};
const sectionTitle = (title) => (SECTION_TITLE[title] ? SECTION_TITLE[title]() : title);

const HEAD = 'font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8C94A0';

/** One version's notes: a summary, then Added / Changed / Fixed… with their bullets. */
export function Notes({ entry }) {
  return html`
    <div style="display: flex; flex-direction: column; gap: 14px">
      ${entry.summary && html`<p style="margin: 0; color: #C9CED6; line-height: 1.5">${inline(entry.summary)}</p>`}
      ${entry.sections.map((s) => html`
        <section key=${s.title} style="display: flex; flex-direction: column; gap: 8px">
          <span style=${HEAD}>${sectionTitle(s.title)}</span>
          <ul style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; color: #C9CED6; line-height: 1.5">
            ${s.items.map((it, k) => html`
              <li key=${k}>${inline(it.text)}
                ${it.children.length > 0 && html`<ul style="margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; color: #9BA3AF">${it.children.map((c, j) => html`<li key=${j}>${inline(c)}</li>`)}</ul>`}
              </li>`)}
          </ul>
        </section>`)}
    </div>`;
}
