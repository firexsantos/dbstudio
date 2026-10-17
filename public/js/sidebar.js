// Left rail + sidebar panels: connections, explorer tree, background jobs.
import {
  $, $$, h, icon, esc, api, qs, state, app, on, emit, local, toast, showMenu, copyText, fmtNum, timeAgo,
  TYPE_LABEL, engineBadge, nsLabel, quoteIdent, download, currentTab,
} from './core.js';
import { LOGO, stagger, switchTheme } from './fx.js';
import { connSub } from './conn.js';
import { t, plural } from './i18n.js';

let panel = local.get('dbs-panel', 'connections');
const collapsed = new Set(local.get('dbs-tree-collapsed', ['events']));

export function initSidebar() {
  $('.rail-logo').innerHTML = LOGO;
  $('.rail-logo').onclick = () => app.openPalette();
  $$('.rail-btn[data-panel]').forEach((b) => (b.onclick = () => showPanel(b.dataset.panel, { toggle: true })));
  $$('.rail-btn[data-tool]').forEach((b) => (b.onclick = () => app.openTool(b.dataset.tool)));
  $('#btn-theme').onclick = (e) => switchTheme(e.currentTarget);
  $('#btn-palette').onclick = () => app.openPalette();
  $('#btn-new-conn').onclick = () => app.openConnDialog();
  $('#btn-refresh-jobs').onclick = refreshJobs;
  on('connected', renderExplorer);
  on('connecting', markConnecting);
  on('jobs', renderJobs);
  on('tab', highlightOpen);
  showPanel(panel);
  setInterval(() => {
    if ([...state.jobs.values()].some((j) => j.status === 'running')) renderJobs();
  }, 1000);
}

export function showPanel(name, { toggle = false } = {}) {
  const appEl = $('#app');
  if (toggle && name === panel && !appEl.classList.contains('no-side')) {
    appEl.classList.add('no-side');
    $$('.rail-btn[data-panel]').forEach((b) => b.classList.remove('active'));
    moveRailIndicator(null);
    return;
  }
  appEl.classList.remove('no-side');
  panel = name;
  local.set('dbs-panel', name);
  $$('.side-panel').forEach((p) => {
    const show = p.dataset.panel === name;
    if (show && p.hidden) {
      p.classList.remove('panel-view');
      void p.offsetWidth;
      p.classList.add('panel-view');
    }
    p.hidden = !show;
  });
  $$('.rail-btn[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  moveRailIndicator($(`.rail-btn[data-panel="${name}"]`));
  if (name === 'jobs') refreshJobs();
}

function moveRailIndicator(btn) {
  const ind = $('.rail-indicator');
  if (!btn) {
    ind.style.opacity = 0;
    return;
  }
  ind.style.opacity = 1;
  ind.style.transform = `translateY(${btn.offsetTop}px)`;
}

// ---------------------------------------------------------------- connections panel
export function connCard(c, { compact = false } = {}) {
  const active = state.active?.conn.id === c.id;
  const open = state.workspaces.filter((w) => w.conn.id === c.id);
  const card = h(
    'div',
    { class: 'conn-card' + (active ? ' active' : '') + (open.length && !active ? ' open' : ''), 'data-id': c.id, title: `${TYPE_LABEL[c.type]} — ${connSub(c)}` },
    h('span', { class: 'cc-tag', style: { background: c.color || 'var(--text-3)' } }),
    h('span', { html: engineBadge(c.type) }),
    h(
      'div',
      { class: 'cc-text' },
      h('div', { class: 'cc-name', text: c.name || t('(untitled)') }),
      h('div', { class: 'cc-sub', html: (c.ssh?.enabled ? icon('shield-check') : '') + esc(connSub(c)) }),
    ),
    open.length ? h('span', { class: 'pulse on', title: plural(open.length, 'Open in {n} tab', 'Open in {n} tabs') }) : null,
    compact
      ? null
      : h(
          'div',
          { class: 'cc-actions' },
          h('button', { class: 'btn ghost xs icon cc-star' + (c.favorite ? ' on' : ''), title: c.favorite ? t('Remove from favorites') : t('Add to favorites'), html: icon('star'), onclick: (e) => (e.stopPropagation(), app.toggleFavorite(c)) }),
          h('button', { class: 'btn ghost xs icon', title: 'Edit', html: icon('settings-2'), onclick: (e) => (e.stopPropagation(), app.openConnDialog(c)) }),
        ),
    !compact && c.favorite ? h('span', { class: 'cc-fav', html: icon('star') }) : null,
  );
  card.onclick = () => app.connect(c.id);
  card.oncontextmenu = (e) =>
    showMenu(e, [
      { label: c.name, header: true },
      { label: open.length ? t('Go to this connection') : t('Connect'), icon: 'zap', action: () => app.connect(c.id) },
      open.length ? { label: t('Open again in a new tab'), icon: 'copy-plus', action: () => app.connect(c.id, { fresh: true }) } : null,
      { label: 'Edit…', icon: 'settings-2', action: () => app.openConnDialog(c) },
      { label: t('Duplicate'), icon: 'copy', action: () => app.duplicateConn(c) },
      { label: c.favorite ? t('Remove from favorites') : t('Add to favorites'), icon: 'star', action: () => app.toggleFavorite(c) },
      { label: t('Move to group…'), icon: 'folder-input', action: () => app.groupPicker(e, [c]) },
      { label: t('Export this connection…'), icon: 'upload', action: () => app.openExportDialog({ ids: [c.id] }) },
      ...open.map((w) => ({ label: open.length > 1 ? t('Close {ns}', { ns: w.ns }) : t('Disconnect'), icon: 'unplug', action: () => app.disconnect(w.wid) })),
      '-',
      { label: t('Delete connection'), icon: 'trash-2', danger: true, action: () => app.deleteConn(c) },
    ]);
  return card;
}

function markConnecting(id) {
  const card = $(`#conn-list .conn-card[data-id="${id}"]`);
  if (!card) return;
  card.classList.remove('warp');
  void card.offsetWidth;
  card.classList.add('warp');
  card.querySelector('.cc-sub').innerHTML = `${icon('loader-circle', 'spin')} ${t('connecting…')}`;
}

// ---------------------------------------------------------------- explorer
/** Load the object tree of a workspace (the one on screen by default); only the visible one is re-rendered. */
export async function loadTree(a = state.active) {
  if (!a) return renderExplorer();
  a.loading = true;
  if (a === state.active) renderExplorer();
  try {
    const p = qs({ ns: a.ns });
    const [tables, cols, objects] = await Promise.all([
      api('GET', `/api/c/${a.conn.id}/tables${p}`),
      api('GET', `/api/c/${a.conn.id}/all-columns${p}`).catch(() => ({})),
      api('GET', `/api/c/${a.conn.id}/objects${p}`).catch(() => ({ routines: [], triggers: [], events: [] })),
    ]);
    a.tables = tables;
    a.columns = cols;
    a.objects = objects;
  } catch (e) {
    toast(e.message, 'err', { title: t('Could not load objects from {name}', { name: a.conn.name }) });
  } finally {
    a.loading = false;
  }
  if (a !== state.active) return;
  renderExplorer();
  emit('tree');
}

export async function refreshNamespaces() {
  const a = state.active;
  if (!a) return;
  a.namespaces = await api('GET', `/api/c/${a.conn.id}/namespaces`);
  if (!a.namespaces.includes(a.ns)) a.ns = a.namespaces[0];
  renderExplorer();
}

export async function setNamespace(ns) {
  state.active.ns = ns;
  emit('ns');
  await loadTree();
}

function renderExplorer() {
  const el = $('#explorer');
  el.innerHTML = '';
  const a = state.active;
  if (!a) {
    el.append(
      h('div', { class: 'side-head' }, h('div', { class: 'side-title', text: 'Explorer' })),
      h(
        'div',
        { class: 'empty', style: { flex: 1 } },
        h('div', { html: icon('database-zap') }),
        h('div', { text: t('Not connected to a database.') }),
        h('button', { class: 'btn primary sm', html: icon('plug') + `<span>${t('Choose a connection')}</span>`, onclick: () => showPanel('connections') }),
      ),
    );
    return;
  }
  const type = a.conn.type;
  const pg = type === 'postgres';
  el.append(
    h('div', { class: 'side-head' }, h('div', { class: 'side-title', text: 'Explorer' }),
      h('button', { class: 'btn ghost xs icon', title: t('Refresh'), html: icon('refresh-cw'), onclick: () => (refreshNamespaces(), loadTree()) }),
      h('button', { class: 'btn ghost xs icon', title: t('Server info'), html: icon('server'), onclick: () => app.openTool('server') }),
      h('button', { class: 'btn ghost xs icon', title: t('Disconnect'), html: icon('unplug'), onclick: () => app.disconnect() }),
    ),
    h(
      'div',
      { class: 'active-conn' },
      h('span', { html: engineBadge(type) }),
      h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'ac-name', text: a.conn.name }), h('div', { class: 'ac-sub', text: `${TYPE_LABEL[type]} ${String(a.version || '').split(/[ -]/)[0]}${a.conn.ssh?.enabled ? ' · SSH' : ''}` })),
      h('span', { class: 'pulse on' }),
    ),
  );

  if (type !== 'sqlite') {
    const sel = h('select', { class: 'select sm grow', title: nsLabel(type) });
    for (const n of a.namespaces) {
      const o = h('option', { value: n }, n);
      if (n === a.ns) o.selected = true;
      sel.append(o);
    }
    sel.onchange = () => setNamespace(sel.value);
    el.append(
      h(
        'div',
        { class: 'ns-row' },
        sel,
        h('button', { class: 'btn sm icon', title: pg ? t('New schema') : t('New database'), html: icon('folder-plus'), onclick: () => app.createNamespace() }),
        h('button', { class: 'btn sm icon', title: pg ? t('Schema actions') : t('Database actions'), html: icon('ellipsis'), onclick: (e) => nsMenu(e) }),
      ),
    );
  }
  const filter = h('input', { class: 'input sm', placeholder: t('Search tables, views, routines…'), value: state.treeFilter || '' });
  filter.oninput = () => {
    state.treeFilter = filter.value;
    renderTree(treeBox);
  };
  el.append(h('div', { class: 'tree-filter' }, h('div', { class: 'search', html: icon('search') }, filter)));
  const treeBox = h('div', { class: 'side-scroll' });
  el.append(treeBox);
  renderTree(treeBox);
}

function nsMenu(e) {
  const a = state.active;
  const pg = a.conn.type === 'postgres';
  showMenu(e, [
    { label: a.ns, header: true },
    { label: pg ? t('Open another schema in a new tab…') : t('Open another database in a new tab…'), icon: 'copy-plus', action: () => app.nsPicker(e, a) },
    { label: pg ? t('New schema…') : t('New database…'), icon: 'folder-plus', action: () => app.createNamespace() },
    { label: t('New table…'), icon: 'table-properties', action: () => app.openDesigner(null) },
    { label: t('View ERD'), icon: 'workflow', action: () => app.openTool('erd') },
    '-',
    { label: 'Query Builder', icon: 'blocks', action: () => app.openTool('qb') },
    { label: t('Search in database…'), icon: 'search-code', action: () => app.openTool('finder') },
    { label: t('Test data generator…'), icon: 'wand-sparkles', action: () => app.openTool('datagen') },
    { label: 'Data dictionary…', icon: 'book-open-text', action: () => app.openTool('dictionary') },
    { label: 'Backup & restore', icon: 'archive-restore', action: () => app.openTool('backup') },
    '-',
    { label: pg ? t('Copy schema to…') : t('Copy database to…'), icon: 'copy-plus', action: () => app.openCopy({ all: true }) },
    { label: t('Data sync…'), icon: 'arrow-left-right', action: () => app.openTool('datasync') },
    { label: pg ? t('Export schema (SQL)') : t('Export database (SQL)'), icon: 'download', action: () => app.openTransfer({ tab: 'export-sql' }) },
    { label: t('Import SQL file'), icon: 'upload', action: () => app.openTransfer({ tab: 'import-sql' }) },
    { label: t('Compare schemas'), icon: 'git-compare', action: () => app.openTool('compare') },
    '-',
    { label: pg ? t('Drop schema "{name}"…', { name: a.ns }) : t('Drop database "{name}"…', { name: a.ns }), icon: 'trash-2', danger: true, action: () => app.dropNamespace(a.ns) },
  ]);
}

function section(key, title, ico, items, renderItem, headActs = []) {
  const sec = h('div', { class: 'tree-sec' + (collapsed.has(key) ? ' collapsed' : '') });
  const head = h(
    'div',
    { class: 'tree-head' },
    h('span', { html: icon('chevron-down', 'chev') }),
    h('span', { html: icon(ico) }),
    h('span', { text: title }),
    ...headActs.map((a) => h('button', { class: 'btn ghost xs icon head-act', title: a.title, html: icon(a.icon), onclick: (e) => (e.stopPropagation(), a.action()) })),
    h('span', { class: 'count', text: String(items.length) }),
  );
  head.onclick = () => {
    sec.classList.toggle('collapsed');
    if (sec.classList.contains('collapsed')) collapsed.add(key);
    else collapsed.delete(key);
    local.set('dbs-tree-collapsed', [...collapsed]);
  };
  const list = h('div');
  for (const it of items) list.append(renderItem(it));
  stagger(list);
  sec.append(head, h('div', { class: 'tree-body' }, list));
  return sec;
}

function renderTree(box) {
  box.innerHTML = '';
  const a = state.active;
  if (a?.loading) {
    for (let i = 0; i < 9; i++) box.append(h('div', { class: 'skeleton', style: { height: '18px', margin: '8px 10px', width: `${55 + ((i * 37) % 40)}%` } }));
    return;
  }
  const f = (state.treeFilter || '').trim().toLowerCase();
  const match = (n) => !f || String(n).toLowerCase().includes(f);
  const tables = state.tables.filter((x) => x.kind === 'table' && match(x.name));
  const views = state.tables.filter((x) => x.kind === 'view' && match(x.name));
  const { routines = [], triggers = [], events = [] } = state.objects || {};
  const r = routines.filter((x) => match(x.name));
  const tr = triggers.filter((x) => match(x.name));
  const ev = events.filter((x) => match(x.name));

  box.append(
    section('tables', t('Tables'), 'table-2', tables, (tb) => tableItem(tb), [
      { icon: 'plus', title: t('New table'), action: () => app.openDesigner(null) },
      { icon: 'workflow', title: 'ERD', action: () => app.openTool('erd') },
    ]),
    section('views', t('Views'), 'eye', views, (tb) => tableItem(tb)),
  );
  if (a.conn.type !== 'sqlite') {
    box.append(section('routines', t('Routines'), 'function-square', r, (x) => objItem(x, x.kind, x.kind === 'procedure' ? 'cog' : 'sigma', 'routine')));
  }
  box.append(section('triggers', t('Triggers'), 'zap', tr, (x) => objItem(x, 'trigger', 'zap', 'trigger', x.tbl)));
  if (a.conn.type === 'mysql') box.append(section('events', t('Events'), 'calendar-clock', ev, (x) => objItem(x, 'event', 'calendar-clock', 'trigger', x.info)));
  if (!state.tables.length && !f) {
    box.append(h('div', { class: 'empty' }, h('div', { text: a.conn.type === 'postgres' ? t('This schema is empty.') : t('This database is empty.') }), h('button', { class: 'btn sm primary', html: icon('plus') + `<span>${t('Create table')}</span>`, onclick: () => app.openDesigner(null) })));
  }
  highlightOpen();
}

function tableItem(tb) {
  const it = h(
    'div',
    { class: 'tree-item ' + tb.kind, 'data-table': tb.name, title: tb.name },
    h('span', { html: icon(tb.kind === 'view' ? 'eye' : 'table-2') }),
    h('span', { class: 'ti-name', text: tb.name }),
    tb.approxRows != null ? h('span', { class: 'ti-meta', text: '~' + fmtNum(tb.approxRows) }) : null,
  );
  it.onclick = () => app.openTableTab(tb.name);
  it.oncontextmenu = (e) => tableMenu(e, tb);
  return it;
}

function tableMenu(e, tb) {
  const type = state.active.conn.type;
  const isView = tb.kind === 'view';
  showMenu(e, [
    { label: tb.name, header: true },
    { label: t('Open data'), icon: 'table', action: () => app.openTableTab(tb.name) },
    isView ? { label: t('View definition'), icon: 'file-code-2', action: () => app.showObjectDef('view', tb) } : { label: t('Design table…'), icon: 'pencil-ruler', action: () => app.openDesigner(tb.name) },
    { label: t('Structure & relations'), icon: 'list-tree', action: () => app.openTableTab(tb.name, 'structure') },
    isView ? null : { label: t('Show in ERD'), icon: 'workflow', action: () => app.openTool('erd', { focus: tb.name }) },
    '-',
    { label: 'Query: SELECT *', icon: 'square-terminal', action: () => app.newQueryTab(`SELECT * FROM ${quoteIdent(tb.name, type)} LIMIT 100;`, true) },
    { label: t('Query: count rows'), icon: 'hash', action: () => app.newQueryTab(`SELECT COUNT(*) FROM ${quoteIdent(tb.name, type)};`, true) },
    '-',
    isView ? null : { label: t('Copy to another database / server…'), icon: 'copy-plus', action: () => app.openCopy({ tables: [tb.name] }) },
    isView ? null : { label: t('Duplicate table…'), icon: 'copy', action: () => app.duplicateTable(tb.name) },
    isView ? null : { label: t('Fill with test data…'), icon: 'wand-sparkles', action: () => app.openDataGen({ table: tb.name }) },
    { label: 'Export (CSV / JSON / SQL)…', icon: 'download', action: () => app.openTransfer({ tab: 'export-data', table: tb.name }) },
    isView ? null : { label: t('Import CSV into this table…'), icon: 'upload', action: () => app.openTransfer({ tab: 'import-csv', table: tb.name }) },
    '-',
    { label: t('Rename…'), icon: 'text-cursor-input', action: () => app.tableOp('rename', tb.name, tb.kind) },
    isView ? null : { label: t('Empty (TRUNCATE)…'), icon: 'eraser', danger: true, action: () => app.tableOp('truncate', tb.name, tb.kind) },
    { label: isView ? t('Drop view…') : t('Drop table…'), icon: 'trash-2', danger: true, action: () => app.tableOp('drop', tb.name, tb.kind) },
    { label: t('Copy name'), icon: 'clipboard', action: () => copyText(tb.name) },
  ]);
}

function objItem(x, kind, ico, cls, meta) {
  const it = h('div', { class: `tree-item ${cls}`, title: x.name }, h('span', { html: icon(ico) }), h('span', { class: 'ti-name', text: x.name }), meta ? h('span', { class: 'ti-meta', text: meta }) : null);
  it.onclick = () => app.showObjectDef(kind, x);
  it.oncontextmenu = (e) =>
    showMenu(e, [
      { label: x.name, header: true },
      { label: t('View / edit definition'), icon: 'file-code-2', action: () => app.showObjectDef(kind, x) },
      { label: t('Copy name'), icon: 'clipboard', action: () => copyText(x.name) },
      '-',
      { label: t('Drop…'), icon: 'trash-2', danger: true, action: () => app.dropObject(kind, x) },
    ]);
  return it;
}

function highlightOpen() {
  const tab = currentTab();
  $$('#explorer .tree-item[data-table]').forEach((el) => el.classList.toggle('open', Boolean(tab && tab.kind === 'table' && tab.table === el.dataset.table && tab.ns === state.active?.ns)));
}

// ---------------------------------------------------------------- jobs
export async function refreshJobs() {
  try {
    for (const j of await api('GET', '/api/jobs')) state.jobs.set(j.id, j);
  } catch {
    /* server unavailable */
  }
  renderJobs();
}

const JOB_ICON = { copy: 'copy-plus', dump: 'download', export: 'file-down', import: 'upload' };
function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  const running = jobs.filter((j) => j.status === 'running').length;
  const badge = $('.rail-btn[data-panel="jobs"] .badge-dot');
  badge.hidden = !running;
  badge.textContent = running;
  const box = $('#job-list');
  if (!box || box.closest('[hidden]')) return;
  box.innerHTML = '';
  if (!jobs.length) {
    box.append(h('div', { class: 'empty' }, h('div', { html: icon('list-checks') }), h('div', { text: t('No jobs yet. Copies, exports and imports show up here.') })));
    return;
  }
  for (const j of jobs) {
    const pct = Math.round(j.progress * 100);
    const chip =
      j.status === 'running' ? `<span class="chip info">${pct}%</span>` : j.status === 'done' ? `<span class="chip ok">${icon('check')} ${t('done')}</span>` : j.status === 'cancelled' ? `<span class="chip warn">${t('cancelled')}</span>` : `<span class="chip danger">${icon('x')} ${t('failed')}</span>`;
    const card = h(
      'div',
      { class: 'job-card' },
      h('div', { class: 'jc-head', html: `${icon(JOB_ICON[j.kind] || 'cog')}<div class="jc-title" title="${esc(j.title)}">${esc(j.title)}</div>${chip}` }),
      h('div', { class: 'progress' + (j.status === 'done' ? ' done' : j.status === 'error' ? ' error' : ''), html: `<i style="--p:${pct}%"></i>` }),
      h('div', { class: 'jc-phase', html: `<span>${esc(j.error || j.phase || '')}</span><span>${timeAgo(j.startedAt)}</span>` }),
    );
    const acts = h('div', { class: 'row', style: { marginTop: '8px' } });
    if (j.download) acts.append(h('button', { class: 'btn sm primary', html: icon('download') + `<span>${t('Download')}</span>`, onclick: () => download(j.download) }));
    if (j.status === 'running') acts.append(h('button', { class: 'btn sm', html: icon('square') + `<span>${t('Cancel')}</span>`, onclick: () => api('POST', `/api/jobs/${j.id}/cancel`) }));
    if (acts.children.length) card.append(acts);
    box.append(card);
  }
}

Object.assign(app, { showPanel, loadTree, refreshNamespaces, setNamespace, refreshJobs });
