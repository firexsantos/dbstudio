// "What's new" — shown once after an update, and on demand from the command palette.
import { h, icon, api, app, local, modal } from './core.js';
import { t } from './i18n.js';

export const RELEASES = [
  {
    version: '0.3.0',
    title: t('Professional, Navicat-style features'),
    items: [
      ['folder-tree', t('Pro connection management'), t('Groups/folders, favorites, search, drag & drop, sort by last used.')],
      ['download', t('Import & export connections'), t('Including from Navicat (.ncx) and DBeaver — exports can be encrypted with a passphrase.')],
      ['arrow-left-right', t('Data sync'), t('Compare table contents row by row, across servers & engines, then apply or save the script.')],
      ['wand-sparkles', t('Test data generator'), t('Realistic Indonesian-flavored data that respects types, UNIQUE, ENUM/CHECK and relations.')],
      ['blocks', t('Visual Query Builder'), t('Drag tables, automatic JOINs from relations, filters & aggregates without typing SQL.')],
      ['chart-column', t('Charts'), t('Turn query results into bar, line, area, donut or scatter charts — export PNG/SVG.')],
      ['search-code', t('Search database'), t('Find values across all tables & columns at once.')],
      ['notebook-tabs', t('Form view, value viewer & FK navigation'), t('One row per page, JSON/image BLOBs, Ctrl+click to jump to the referenced row.')],
      ['sheet', t('Excel export & more'), t('Excel, CSV, JSON, Markdown, HTML, SQL INSERT — from query results or tables.')],
      ['book-open-text', t('Data dictionary'), t('A shareable HTML/Markdown document of the whole schema.')],
      ['archive-restore', t('Backup & restore'), t('One-click backups with history and restore.')],
      ['languages', t('Multi-language interface'), t('English & Indonesian — switch anytime in Settings.')],
      ['settings', t('Settings page'), t('Language, theme and data folder in one place.')],
    ],
  },
];

export function openWhatsNew() {
  const r = RELEASES[0];
  const list = h('div', { class: 'wn-list' });
  r.items.forEach(([ico, title, text], i) => list.append(h('div', { class: 'wn-item', style: { '--i': i } }, h('div', { class: 'wn-ico', html: icon(ico) }), h('div', {}, h('b', { text: title }), h('div', { class: 'faint', text })))));
  modal({
    title: t("What's new in DBStudio {version}", { version: r.version }),
    sub: r.title,
    icon: 'gift',
    size: 'wide',
    body: h('div', {}, list),
    actions: ['spacer', { label: t('Explore tools'), icon: 'layout-grid', onClick: () => (app.showPanel('tools'), true) }, { label: t('Get started'), kind: 'primary' }],
  });
}

export async function maybeShowWhatsNew() {
  try {
    const { version } = await api('GET', '/api/meta');
    const seen = local.get('dbs-seen-version', null);
    local.set('dbs-seen-version', version);
    // 0.2.0 did not record a version, so an existing workspace without one also counts as an upgrade.
    const returning = seen || local.get('dbs-panel', null) != null || local.get('dbs-queries', null) != null;
    if (returning && seen !== version && RELEASES.some((x) => x.version === version)) openWhatsNew();
  } catch {
    /* offline or old server */
  }
}

Object.assign(app, { openWhatsNew });
