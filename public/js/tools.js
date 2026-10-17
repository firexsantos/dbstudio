// "Tools" hub: every tool as a tilting glass card, grouped by purpose.
import { $, h, icon, state, app, on } from './core.js';
import { motionOK } from './fx.js';
import { t } from './i18n.js';

export const TOOLS = [
  { group: t('Data'), items: [
    { id: 'copy', icon: 'copy-plus', title: t('Copy table'), sub: t('To another database, server or engine'), hue: 265 },
    { id: 'datasync', icon: 'arrow-left-right', title: t('Data sync'), sub: t('Compare table contents & match rows'), hue: 190, conn: false, isNew: true },
    { id: 'datagen', icon: 'wand-sparkles', title: t('Data generator'), sub: t('Fill tables with realistic test data'), hue: 320, conn: true, isNew: true },
    { id: 'finder', icon: 'search-code', title: t('Search database'), sub: t('Find values across all tables & columns'), hue: 40, conn: true, isNew: true },
  ] },
  { group: t('Structure'), items: [
    { id: 'qb', icon: 'blocks', title: t('Query Builder'), sub: t('Build queries visually without typing SQL'), hue: 150, conn: true, isNew: true },
    { id: 'erd', icon: 'workflow', title: t('ERD diagram'), sub: t('Interactive table relations'), hue: 210, conn: true },
    { id: 'compare', icon: 'git-compare', title: t('Schema compare'), sub: t('Sync the structure of two databases'), hue: 280 },
    { id: 'dictionary', icon: 'book-open-text', title: t('Data dictionary'), sub: t('HTML/Markdown document of the whole schema'), hue: 20, conn: true, isNew: true },
  ] },
  { group: t('Operations'), items: [
    { id: 'backup', icon: 'archive-restore', title: t('Backup & restore'), sub: t('One-click backups with history'), hue: 160, conn: true, isNew: true },
    { id: 'transfer', icon: 'arrow-down-up', title: t('Export & import'), sub: 'SQL, CSV, JSON, Excel', hue: 230, conn: true },
    { id: 'server', icon: 'server', title: t('Server info'), sub: t('Processes, variables, status, users'), hue: 0, conn: true },
  ] },
];

function tilt(card) {
  if (!motionOK()) return;
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    card.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
    card.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
    card.style.setProperty('--gx', `${x * 100}%`);
    card.style.setProperty('--gy', `${y * 100}%`);
  });
  card.addEventListener('pointerleave', () => {
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
  });
}

export function renderTools() {
  const box = $('#tool-list');
  if (!box) return;
  box.innerHTML = '';
  const connected = Boolean(state.active);
  let i = 0;
  for (const g of TOOLS) {
    box.append(h('div', { class: 'section-label tool-group', text: g.group }));
    const grid = h('div', { class: 'tool-grid' });
    for (const tool of g.items) {
      const needs = tool.conn && !connected;
      const card = h(
        'button',
        { class: 'tool-card' + (needs ? ' needs' : ''), style: { '--h': tool.hue, '--i': i++ }, title: needs ? t('Connect to a database first') : tool.sub },
        h('span', { class: 'tc-glare' }),
        h('span', { class: 'tc-ico', html: icon(tool.icon) }),
        h('span', { class: 'tc-title', text: tool.title }),
        h('span', { class: 'tc-sub', text: tool.sub }),
        tool.isNew ? h('span', { class: 'tc-new', text: t('new') }) : null,
      );
      card.onclick = () => app.openTool(tool.id);
      tilt(card);
      grid.append(card);
    }
    box.append(grid);
  }
}

on('connected', renderTools);
document.addEventListener('DOMContentLoaded', renderTools);
Object.assign(app, { renderTools });
