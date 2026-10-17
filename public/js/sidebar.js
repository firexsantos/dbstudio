// Left rail + sidebar panels: connections, explorer tree, background jobs.
import {
  $, $$, h, icon, esc, api, qs, state, app, on, emit, local, toast, showMenu, copyText, fmtNum, timeAgo,
  TYPE_LABEL, engineBadge, nsLabel, quoteIdent, download, currentTab,
} from './core.js';
import { LOGO, stagger, switchTheme } from './fx.js';
import { connSub } from './conn.js';

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
  on('conns', renderConnections);
  on('connected', () => {
    renderConnections();
    renderExplorer();
  });
  on('connecting', markConnecting);
  on('connect-failed', renderConnections);
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
function renderConnections() {
  const box = $('#conn-list');
  box.innerHTML = '';
  if (!state.conns.length) {
    box.append(
      h(
        'div',
        { class: 'empty' },
        h('div', { html: icon('plug') }),
        h('div', { text: 'Belum ada koneksi tersimpan.' }),
        h('button', { class: 'btn primary sm', html: icon('plus') + '<span>Koneksi baru</span>', onclick: () => app.openConnDialog() }),
        h('button', { class: 'btn sm', html: icon('sparkles') + '<span>Coba database demo</span>', onclick: () => app.openDemo() }),
      ),
    );
    return;
  }
  for (const c of state.conns) box.append(connCard(c));
  stagger(box);
}

export function connCard(c, { compact = false } = {}) {
  const active = state.active?.conn.id === c.id;
  const card = h(
    'div',
    { class: 'conn-card' + (active ? ' active' : ''), 'data-id': c.id, title: `${TYPE_LABEL[c.type]} — ${connSub(c)}` },
    h('span', { class: 'cc-tag', style: { background: c.color || 'var(--text-3)' } }),
    h('span', { html: engineBadge(c.type) }),
    h(
      'div',
      { class: 'cc-text' },
      h('div', { class: 'cc-name', text: c.name || '(tanpa nama)' }),
      h('div', { class: 'cc-sub', html: (c.ssh?.enabled ? icon('shield-check') : '') + esc(connSub(c)) }),
    ),
    active ? h('span', { class: 'pulse on' }) : null,
    compact
      ? null
      : h(
          'div',
          { class: 'cc-actions' },
          h('button', { class: 'btn ghost xs icon', title: 'Edit', html: icon('settings-2'), onclick: (e) => (e.stopPropagation(), app.openConnDialog(c)) }),
        ),
  );
  card.onclick = () => app.connect(c.id);
  card.oncontextmenu = (e) =>
    showMenu(e, [
      { label: c.name, header: true },
      { label: 'Hubungkan', icon: 'zap', action: () => app.connect(c.id) },
      { label: 'Edit…', icon: 'settings-2', action: () => app.openConnDialog(c) },
      { label: 'Duplikat', icon: 'copy', action: () => app.duplicateConn(c) },
      active ? { label: 'Putuskan', icon: 'unplug', action: () => app.disconnect() } : null,
      '-',
      { label: 'Hapus koneksi', icon: 'trash-2', danger: true, action: () => app.deleteConn(c) },
    ]);
  return card;
}

function markConnecting(id) {
  const card = $(`#conn-list .conn-card[data-id="${id}"]`);
  if (!card) return;
  card.classList.remove('warp');
  void card.offsetWidth;
  card.classList.add('warp');
  card.querySelector('.cc-sub').innerHTML = `${icon('loader-circle', 'spin')} menghubungkan…`;
}

// ---------------------------------------------------------------- explorer
export async function loadTree() {
  const a = state.active;
  if (!a) return renderExplorer();
  state.treeLoading = true;
  renderExplorer();
  try {
    const p = qs({ ns: a.ns });
    const [tables, cols, objects] = await Promise.all([
      api('GET', `/api/c/${a.conn.id}/tables${p}`),
      api('GET', `/api/c/${a.conn.id}/all-columns${p}`).catch(() => ({})),
      api('GET', `/api/c/${a.conn.id}/objects${p}`).catch(() => ({ routines: [], triggers: [], events: [] })),
    ]);
    if (state.active !== a) return;
    state.tables = tables;
    state.columns = cols;
    state.objects = objects;
  } catch (e) {
    toast(e.message, 'err', { title: 'Gagal memuat objek' });
  } finally {
    state.treeLoading = false;
  }
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
        h('div', { text: 'Belum terhubung ke database.' }),
        h('button', { class: 'btn primary sm', html: icon('plug') + '<span>Pilih koneksi</span>', onclick: () => showPanel('connections') }),
      ),
    );
    return;
  }
  const t = a.conn.type;
  el.append(
    h('div', { class: 'side-head' }, h('div', { class: 'side-title', text: 'Explorer' }),
      h('button', { class: 'btn ghost xs icon', title: 'Muat ulang', html: icon('refresh-cw'), onclick: () => (refreshNamespaces(), loadTree()) }),
      h('button', { class: 'btn ghost xs icon', title: 'Info server', html: icon('server'), onclick: () => app.openTool('server') }),
      h('button', { class: 'btn ghost xs icon', title: 'Putuskan', html: icon('unplug'), onclick: () => app.disconnect() }),
    ),
    h(
      'div',
      { class: 'active-conn' },
      h('span', { html: engineBadge(t) }),
      h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'ac-name', text: a.conn.name }), h('div', { class: 'ac-sub', text: `${TYPE_LABEL[t]} ${String(a.version || '').split(/[ -]/)[0]}${a.conn.ssh?.enabled ? ' · SSH' : ''}` })),
      h('span', { class: 'pulse on' }),
    ),
  );

  if (t !== 'sqlite') {
    const sel = h('select', { class: 'select sm grow', title: nsLabel(t) });
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
        h('button', { class: 'btn sm icon', title: `${nsLabel(t)} baru`, html: icon('folder-plus'), onclick: () => app.createNamespace() }),
        h('button', { class: 'btn sm icon', title: `Aksi ${nsLabel(t).toLowerCase()}`, html: icon('ellipsis'), onclick: (e) => nsMenu(e) }),
      ),
    );
  }
  const filter = h('input', { class: 'input sm', placeholder: 'Cari tabel, view, routine…', value: state.treeFilter || '' });
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
  const label = nsLabel(a.conn.type).toLowerCase();
  showMenu(e, [
    { label: a.ns, header: true },
    { label: `${nsLabel(a.conn.type)} baru…`, icon: 'folder-plus', action: () => app.createNamespace() },
    { label: 'Tabel baru…', icon: 'table-properties', action: () => app.openDesigner(null) },
    { label: 'Lihat ERD', icon: 'workflow', action: () => app.openTool('erd') },
    '-',
    { label: `Salin ${label} ke…`, icon: 'copy-plus', action: () => app.openCopy({ all: true }) },
    { label: `Export ${label} (SQL)`, icon: 'download', action: () => app.openTransfer({ tab: 'export-sql' }) },
    { label: 'Import file SQL', icon: 'upload', action: () => app.openTransfer({ tab: 'import-sql' }) },
    { label: 'Bandingkan skema', icon: 'git-compare', action: () => app.openTool('compare') },
    '-',
    { label: `Hapus ${label} "${a.ns}"…`, icon: 'trash-2', danger: true, action: () => app.dropNamespace(a.ns) },
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
  if (state.treeLoading) {
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
    section('tables', 'Tabel', 'table-2', tables, (t) => tableItem(t), [
      { icon: 'plus', title: 'Tabel baru', action: () => app.openDesigner(null) },
      { icon: 'workflow', title: 'ERD', action: () => app.openTool('erd') },
    ]),
    section('views', 'View', 'eye', views, (t) => tableItem(t)),
  );
  if (a.conn.type !== 'sqlite') {
    box.append(section('routines', 'Routine', 'function-square', r, (x) => objItem(x, x.kind, x.kind === 'procedure' ? 'cog' : 'sigma', 'routine')));
  }
  box.append(section('triggers', 'Trigger', 'zap', tr, (x) => objItem(x, 'trigger', 'zap', 'trigger', x.tbl)));
  if (a.conn.type === 'mysql') box.append(section('events', 'Event', 'calendar-clock', ev, (x) => objItem(x, 'event', 'calendar-clock', 'trigger', x.info)));
  if (!state.tables.length && !f) {
    box.append(h('div', { class: 'empty' }, h('div', { text: `${nsLabel(a.conn.type)} ini masih kosong.` }), h('button', { class: 'btn sm primary', html: icon('plus') + '<span>Buat tabel</span>', onclick: () => app.openDesigner(null) })));
  }
  highlightOpen();
}

function tableItem(t) {
  const it = h(
    'div',
    { class: 'tree-item ' + t.kind, 'data-table': t.name, title: t.name },
    h('span', { html: icon(t.kind === 'view' ? 'eye' : 'table-2') }),
    h('span', { class: 'ti-name', text: t.name }),
    t.approxRows != null ? h('span', { class: 'ti-meta', text: '~' + fmtNum(t.approxRows) }) : null,
  );
  it.onclick = () => app.openTableTab(t.name);
  it.oncontextmenu = (e) => tableMenu(e, t);
  return it;
}

function tableMenu(e, t) {
  const type = state.active.conn.type;
  const isView = t.kind === 'view';
  showMenu(e, [
    { label: t.name, header: true },
    { label: 'Buka data', icon: 'table', action: () => app.openTableTab(t.name) },
    isView ? { label: 'Definisi view', icon: 'file-code-2', action: () => app.showObjectDef('view', t) } : { label: 'Desain tabel…', icon: 'pencil-ruler', action: () => app.openDesigner(t.name) },
    { label: 'Struktur & relasi', icon: 'list-tree', action: () => app.openTableTab(t.name, 'structure') },
    isView ? null : { label: 'Lihat di ERD', icon: 'workflow', action: () => app.openTool('erd', { focus: t.name }) },
    '-',
    { label: 'Query: SELECT *', icon: 'square-terminal', action: () => app.newQueryTab(`SELECT * FROM ${quoteIdent(t.name, type)} LIMIT 100;`, true) },
    { label: 'Query: hitung baris', icon: 'hash', action: () => app.newQueryTab(`SELECT COUNT(*) FROM ${quoteIdent(t.name, type)};`, true) },
    '-',
    isView ? null : { label: 'Salin ke database / server lain…', icon: 'copy-plus', action: () => app.openCopy({ tables: [t.name] }) },
    isView ? null : { label: 'Duplikat tabel…', icon: 'copy', action: () => app.duplicateTable(t.name) },
    { label: 'Export (CSV / JSON / SQL)…', icon: 'download', action: () => app.openTransfer({ tab: 'export-data', table: t.name }) },
    isView ? null : { label: 'Import CSV ke tabel ini…', icon: 'upload', action: () => app.openTransfer({ tab: 'import-csv', table: t.name }) },
    '-',
    { label: 'Ganti nama…', icon: 'text-cursor-input', action: () => app.tableOp('rename', t.name, t.kind) },
    isView ? null : { label: 'Kosongkan (TRUNCATE)…', icon: 'eraser', danger: true, action: () => app.tableOp('truncate', t.name, t.kind) },
    { label: isView ? 'Hapus view…' : 'Hapus tabel…', icon: 'trash-2', danger: true, action: () => app.tableOp('drop', t.name, t.kind) },
    { label: 'Salin nama', icon: 'clipboard', action: () => copyText(t.name) },
  ]);
}

function objItem(x, kind, ico, cls, meta) {
  const it = h('div', { class: `tree-item ${cls}`, title: x.name }, h('span', { html: icon(ico) }), h('span', { class: 'ti-name', text: x.name }), meta ? h('span', { class: 'ti-meta', text: meta }) : null);
  it.onclick = () => app.showObjectDef(kind, x);
  it.oncontextmenu = (e) =>
    showMenu(e, [
      { label: x.name, header: true },
      { label: 'Lihat / edit definisi', icon: 'file-code-2', action: () => app.showObjectDef(kind, x) },
      { label: 'Salin nama', icon: 'clipboard', action: () => copyText(x.name) },
      '-',
      { label: 'Hapus…', icon: 'trash-2', danger: true, action: () => app.dropObject(kind, x) },
    ]);
  return it;
}

function highlightOpen() {
  const t = currentTab();
  $$('#explorer .tree-item[data-table]').forEach((el) => el.classList.toggle('open', Boolean(t && t.kind === 'table' && t.table === el.dataset.table && t.ns === state.active?.ns)));
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
    box.append(h('div', { class: 'empty' }, h('div', { html: icon('list-checks') }), h('div', { text: 'Belum ada pekerjaan. Copy, export, dan import muncul di sini.' })));
    return;
  }
  for (const j of jobs) {
    const pct = Math.round(j.progress * 100);
    const chip =
      j.status === 'running' ? `<span class="chip info">${pct}%</span>` : j.status === 'done' ? `<span class="chip ok">${icon('check')} selesai</span>` : j.status === 'cancelled' ? '<span class="chip warn">dibatalkan</span>' : `<span class="chip danger">${icon('x')} gagal</span>`;
    const card = h(
      'div',
      { class: 'job-card' },
      h('div', { class: 'jc-head', html: `${icon(JOB_ICON[j.kind] || 'cog')}<div class="jc-title" title="${esc(j.title)}">${esc(j.title)}</div>${chip}` }),
      h('div', { class: 'progress' + (j.status === 'done' ? ' done' : j.status === 'error' ? ' error' : ''), html: `<i style="--p:${pct}%"></i>` }),
      h('div', { class: 'jc-phase', html: `<span>${esc(j.error || j.phase || '')}</span><span>${timeAgo(j.startedAt)}</span>` }),
    );
    const acts = h('div', { class: 'row', style: { marginTop: '8px' } });
    if (j.download) acts.append(h('button', { class: 'btn sm primary', html: icon('download') + '<span>Unduh</span>', onclick: () => download(j.download) }));
    if (j.status === 'running') acts.append(h('button', { class: 'btn sm', html: icon('square') + '<span>Batalkan</span>', onclick: () => api('POST', `/api/jobs/${j.id}/cancel`) }));
    if (acts.children.length) card.append(acts);
    box.append(card);
  }
}

Object.assign(app, { showPanel, loadTree, refreshNamespaces, setNamespace, refreshJobs });
