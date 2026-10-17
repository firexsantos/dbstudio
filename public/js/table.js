// Table tabs: Data (editable grid), Structure, Relations & indexes, DDL, Info.
import {
  h, icon, esc, api, qs, state, app, toast, showMenu, copyText, fmtNum, valStr, sqlLiteral, quoteIdent, confirmDialog,
  createEditor, DEFAULT, downloadText,
} from './core.js';
import { addTab, activateTab, renderTabs, findTab } from './tabs.js';
import { renderGrid, nextSort, toCSV } from './grid.js';
import { countUp } from './fx.js';

const newPending = () => ({ edits: new Map(), deletes: new Set(), inserts: [] });
function pendingCount(t) {
  const p = t.pending;
  let n = p.deletes.size + p.inserts.length;
  for (const [r, m] of p.edits) if (m.size && !p.deletes.has(r)) n++;
  return n;
}

const schemaCache = new Map();
export async function schemaOf(connId, ns, { fresh = false } = {}) {
  const key = connId + '\u0000' + ns;
  const hit = schemaCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 30000) return hit.data;
  const data = await api('GET', `/api/c/${connId}/schema${qs({ ns })}`);
  schemaCache.set(key, { at: Date.now(), data });
  return data;
}
export const invalidateSchema = () => schemaCache.clear();

export function openTableTab(table, sub = 'data') {
  const a = state.active;
  if (!a) return;
  const existing = findTab((t) => t.kind === 'table' && t.connId === a.conn.id && t.ns === a.ns && t.table === table);
  if (existing) {
    activateTab(existing.id);
    existing.setSub(sub);
    return existing;
  }
  const isView = state.tables.find((t) => t.name === table)?.kind === 'view';
  const panel = h('div');
  const subtabs = h('div', { class: 'subtabs' });
  const SUBS = [
    ['data', 'Data', 'table'],
    ['structure', 'Struktur', 'list-tree'],
    ['relations', 'Relasi & Index', 'git-fork'],
    ['ddl', 'DDL', 'file-code-2'],
    ['info', 'Info', 'info'],
  ];
  for (const [k, label, ico] of SUBS) subtabs.append(h('button', { class: 'subtab', 'data-sub': k, html: icon(ico) + label }));
  subtabs.append(
    h('span', { class: 'spacer' }),
    isView ? null : h('button', { class: 'btn sm ghost', html: icon('pencil-ruler') + '<span>Desain</span>', onclick: () => app.openDesigner(table) }),
    isView ? null : h('button', { class: 'btn sm ghost', html: icon('workflow') + '<span>ERD</span>', onclick: () => app.openTool('erd', { focus: table }) }),
  );

  // ---- data panel
  const filterInput = h('input', { placeholder: "mis. id > 10 AND status = 'aktif'  — Enter" });
  const limitSel = h('select', { class: 'select sm', style: { width: '78px' }, title: 'Baris per halaman' }, ...[50, 100, 500, 1000].map((n) => h('option', { value: n, selected: n === 100 }, String(n))));
  const pageInfo = h('span', { class: 'info' });
  const pending = h('span', { class: 'chip warn', hidden: true });
  const B = (ico, label, tip, kind = '') => h('button', { class: `btn sm ${kind}`, title: tip || '', html: icon(ico) + (label ? `<span>${label}</span>` : '') });
  const bRefresh = B('refresh-cw', '', 'Muat ulang');
  const bAdd = B('plus', 'Baris', 'Tambah baris');
  const bDel = B('trash-2', 'Hapus', 'Klik nomor baris untuk memilih (Ctrl/Shift untuk banyak)', 'danger');
  const bDiscard = B('undo-2', 'Batal');
  const bApply = B('save', 'Simpan', 'Ctrl+S — semua perubahan dalam satu transaksi', 'primary');
  const bPrev = B('chevron-left', '', 'Sebelumnya');
  const bNext = B('chevron-right', '', 'Berikutnya');
  const bExport = B('download', '', 'Export');
  const notice = h('div', { class: 'notice warn', style: { margin: '10px 12px 0' }, hidden: true, html: icon('lock') + '<div>Tabel/view ini tidak punya <b>primary key</b>, jadi datanya hanya-baca di sini. Ubah lewat tab Query, atau tambahkan primary key di Desain tabel.</div>' });
  const gridWrap = h('div', { class: 'grid-wrap' }, ...Array.from({ length: 8 }, () => h('div', { class: 'skeleton', style: { height: '22px', margin: '10px 14px' } })));
  const dataPanel = h(
    'div',
    { class: 'subpanel', 'data-sub': 'data' },
    h('div', { class: 'toolbar' }, h('div', { class: 'filter-box' }, h('span', { text: 'WHERE' }), filterInput), bRefresh, bAdd, bDel, pending, bDiscard, bApply, h('span', { class: 'spacer' }), limitSel, bPrev, pageInfo, bNext, bExport),
    notice,
    gridWrap,
  );
  const structPanel = h('div', { class: 'subpanel', 'data-sub': 'structure', hidden: true }, h('div', { class: 'grid-wrap' }));
  const relPanel = h('div', { class: 'subpanel', 'data-sub': 'relations', hidden: true }, h('div', { class: 'scroll-pad' }));
  const ddlBox = h('div', { class: 'code-box' });
  const ddlPanel = h(
    'div',
    { class: 'subpanel', 'data-sub': 'ddl', hidden: true },
    h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', html: icon('copy') + '<span>Salin</span>', onclick: () => tab.ddl != null && copyText(tab.ddl) }), h('button', { class: 'btn sm', html: icon('square-terminal') + '<span>Buka di tab query</span>', onclick: () => tab.ddl != null && app.newQueryTab(tab.ddl) })),
    ddlBox,
  );
  const infoPanel = h('div', { class: 'subpanel', 'data-sub': 'info', hidden: true }, h('div', { class: 'scroll-pad' }));
  panel.append(subtabs, dataPanel, structPanel, relPanel, ddlPanel, infoPanel);

  const tab = {
    kind: 'table',
    icon: isView ? 'eye' : 'table-2',
    title: table,
    tooltip: `${a.ns}.${table}`,
    connId: a.conn.id,
    connType: a.conn.type,
    ns: a.ns,
    table,
    isView,
    panel,
    offset: 0,
    limit: 100,
    sort: null,
    filter: '',
    data: null,
    meta: [],
    pending: newPending(),
    selected: new Set(),
    lastSel: null,
    flash: new Set(),
    isDirty: () => pendingCount(tab) > 0,
    onSave: () => applyChanges(tab),
  };
  tab.setSub = (k) => {
    tab.sub = k;
    subtabs.querySelectorAll('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.sub === k));
    for (const p of [dataPanel, structPanel, relPanel, ddlPanel, infoPanel]) {
      const show = p.dataset.sub === k;
      if (show && p.hidden) {
        p.style.animation = 'none';
        void p.offsetWidth;
        p.style.animation = '';
      }
      p.hidden = !show;
    }
    if (k === 'structure') loadStructure(tab, structPanel);
    if (k === 'relations') loadRelations(tab, relPanel);
    if (k === 'ddl') loadDDL(tab, ddlBox);
    if (k === 'info') loadInfo(tab, infoPanel);
  };
  subtabs.querySelectorAll('.subtab').forEach((b) => (b.onclick = () => tab.setSub(b.dataset.sub)));
  tab.ui = { gridWrap, pageInfo, pending, bAdd, bDel, bDiscard, bApply, bPrev, bNext, notice, filterInput };
  addTab(tab);

  const guard = async () => !tab.isDirty() || confirmDialog({ title: 'Buang perubahan?', message: 'Ada perubahan data yang belum disimpan.', danger: true, confirmLabel: 'Buang' });
  filterInput.onkeydown = async (e) => {
    if (e.key !== 'Enter' || !(await guard())) return;
    tab.filter = filterInput.value.trim();
    tab.offset = 0;
    loadData(tab);
  };
  limitSel.onchange = async () => {
    if (!(await guard())) return (limitSel.value = String(tab.limit));
    tab.limit = Number(limitSel.value);
    tab.offset = 0;
    loadData(tab);
  };
  bRefresh.onclick = async () => (await guard()) && loadData(tab);
  bPrev.onclick = async () => {
    if (!(await guard())) return;
    tab.offset = Math.max(0, tab.offset - tab.limit);
    loadData(tab);
  };
  bNext.onclick = async () => {
    if (!(await guard())) return;
    tab.offset += tab.limit;
    loadData(tab);
  };
  bAdd.onclick = () => addRow(tab);
  bDel.onclick = () => toggleDelete(tab, [...tab.selected]);
  bDiscard.onclick = () => {
    tab.pending = newPending();
    tab.selected.clear();
    renderData(tab);
  };
  bApply.onclick = () => applyChanges(tab);
  bExport.onclick = (e) =>
    showMenu(e, [
      { label: 'Halaman ini → CSV', icon: 'file-spreadsheet', action: () => tab.data && downloadText(`${table}.csv`, toCSV(tab.data.columns, tab.data.rows), 'text/csv') },
      { label: 'Seluruh tabel → CSV / JSON / SQL…', icon: 'download', action: () => app.openTransfer({ tab: 'export-data', table }) },
    ]);
  tab.guard = guard;
  tab.setSub(sub);
  loadData(tab);
  return tab;
}

async function loadData(tab) {
  try {
    const d = await api(
      'GET',
      `/api/c/${tab.connId}/data` + qs({ ns: tab.ns, table: tab.table, limit: tab.limit, offset: tab.offset, orderBy: tab.sort?.name, dir: tab.sort?.dir, filter: tab.filter }),
    );
    if (!state.tabs.includes(tab)) return;
    tab.data = d;
    tab.meta = d.columns.map((name) => d.columnsMeta.find((m) => m.name === name) || { name, type: '' });
    tab.canEdit = tab.meta.some((m) => m.pk) && !tab.isView;
    tab.pending = newPending();
    tab.selected.clear();
    renderData(tab, true);
  } catch (e) {
    tab.ui.gridWrap.innerHTML = '';
    tab.ui.gridWrap.append(h('div', { class: 'result-error', text: e.message }));
    tab.ui.pageInfo.textContent = '';
  }
}

function tableValue(tab, r, c) {
  const n = tab.data.rows.length;
  if (r >= n) return tab.pending.inserts[r - n][c];
  const m = tab.pending.edits.get(r);
  return m?.has(c) ? m.get(c) : tab.data.rows[r][c];
}

function setCell(tab, r, c, val) {
  const n = tab.data.rows.length;
  if (r >= n) tab.pending.inserts[r - n][c] = val;
  else {
    const orig = tab.data.rows[r][c];
    const same = val === null ? orig == null : orig != null && valStr(orig) === val;
    const m = tab.pending.edits.get(r) || new Map();
    if (same) m.delete(c);
    else m.set(c, val);
    if (m.size) tab.pending.edits.set(r, m);
    else tab.pending.edits.delete(r);
  }
  renderData(tab);
}

function renderData(tab, fresh = false) {
  const d = tab.data;
  const p = tab.pending;
  const n = d.rows.length;
  const u = tab.ui;
  const flash = tab.flash;
  tab.flash = new Set();
  tab.grid = renderGrid(u.gridWrap, {
    columns: d.columns,
    meta: tab.meta,
    count: n + p.inserts.length,
    getValue: (r, c) => tableValue(tab, r, c),
    sort: tab.sort,
    animate: fresh,
    flash,
    onSort: async (i) => {
      if (!(await tab.guard())) return;
      tab.sort = nextSort(tab.sort, i);
      if (tab.sort) tab.sort.name = d.columns[i];
      tab.offset = 0;
      loadData(tab);
    },
    rowLabel: (r) => (r >= n ? '+' : fmtNum(d.offset + r + 1)),
    rowClass: (r) => (r >= n ? 'row-new' : p.deletes.has(r) ? 'row-deleted' : ''),
    cellClass: (r, c) => (r < n && p.edits.get(r)?.has(c) ? 'dirty' : ''),
    selected: tab.selected,
    editable: (r) => tab.canEdit && !p.deletes.has(r),
    onEdit: (r, c, v) => setCell(tab, r, c, v),
    editNext: (r, c) => {
      if (c >= 0 && c < d.columns.length) tab.grid.edit(r, c);
    },
    rerender: () => renderData(tab),
    onRowNumClick: (r, e) => {
      const s = tab.selected;
      if (e.shiftKey && tab.lastSel != null) for (let i = Math.min(tab.lastSel, r); i <= Math.max(tab.lastSel, r); i++) s.add(i);
      else if (e.ctrlKey || e.metaKey) s.has(r) ? s.delete(r) : s.add(r);
      else {
        const only = s.size === 1 && s.has(r);
        s.clear();
        if (!only) s.add(r);
      }
      tab.lastSel = r;
      renderData(tab);
    },
    onDeleteKey: () => tab.canEdit && tab.selected.size && toggleDelete(tab, [...tab.selected]),
    onCellMenu: (e, r, c) => cellMenu(tab, e, r, c),
  });
  const from = n ? d.offset + 1 : 0;
  u.pageInfo.textContent = `${fmtNum(from)}–${fmtNum(d.offset + n)} dari ${fmtNum(d.total)}`;
  u.bPrev.disabled = d.offset === 0;
  u.bNext.disabled = d.offset + n >= d.total;
  u.notice.hidden = tab.canEdit;
  const count = pendingCount(tab);
  u.pending.hidden = !count;
  u.pending.innerHTML = `${icon('pencil')} ${count} perubahan`;
  u.bApply.hidden = u.bDiscard.hidden = !count;
  u.bAdd.disabled = !tab.canEdit;
  u.bDel.disabled = !tab.canEdit || !tab.selected.size;
  renderTabs();
}

function cellMenu(tab, e, r, c) {
  const d = tab.data;
  const p = tab.pending;
  const v = tableValue(tab, r, c);
  const col = d.columns[c];
  const isNew = r >= d.rows.length;
  const t = tab.connType;
  showMenu(e, [
    { label: 'Salin nilai', icon: 'copy', action: () => copyText(valStr(v)) },
    { label: 'Salin baris (JSON)', icon: 'braces', action: () => copyText(JSON.stringify(Object.fromEntries(d.columns.map((cn, i) => [cn, tableValue(tab, r, i)])), null, 2)) },
    {
      label: 'Salin sebagai INSERT',
      icon: 'file-plus-2',
      action: () =>
        copyText(`INSERT INTO ${quoteIdent(tab.table, t)} (${d.columns.map((cn) => quoteIdent(cn, t)).join(', ')}) VALUES (${d.columns.map((_, i) => sqlLiteral(tableValue(tab, r, i))).join(', ')});`),
    },
    '-',
    { label: 'Edit sel', icon: 'pencil', disabled: !tab.canEdit || p.deletes.has(r), action: () => tab.grid.edit(r, c) },
    { label: 'Set NULL', icon: 'circle-slash', disabled: !tab.canEdit || p.deletes.has(r), action: () => setCell(tab, r, c, null) },
    {
      label: `Filter: ${col} = nilai ini`,
      icon: 'filter',
      disabled: isNew,
      action: async () => {
        if (!(await tab.guard())) return;
        tab.filter = v == null ? `${quoteIdent(col, t)} IS NULL` : `${quoteIdent(col, t)} = ${sqlLiteral(v)}`;
        tab.ui.filterInput.value = tab.filter;
        tab.offset = 0;
        loadData(tab);
      },
    },
    '-',
    {
      label: isNew ? 'Buang baris baru' : p.deletes.has(r) ? 'Batalkan hapus' : 'Tandai hapus baris',
      icon: p.deletes.has(r) ? 'undo-2' : 'trash-2',
      danger: !p.deletes.has(r),
      disabled: !tab.canEdit,
      action: () => toggleDelete(tab, [r]),
    },
  ]);
}

function addRow(tab) {
  if (!tab.canEdit || !tab.data) return;
  tab.pending.inserts.push(tab.data.columns.map(() => DEFAULT));
  renderData(tab);
  const r = tab.data.rows.length + tab.pending.inserts.length - 1;
  const c = Math.max(0, tab.meta.findIndex((m) => !/auto_increment/i.test(m.extra || '')));
  tab.grid.edit(r, c);
}

function toggleDelete(tab, rows) {
  const n = tab.data.rows.length;
  const p = tab.pending;
  for (const r of rows.filter((x) => x >= n).sort((a, b) => b - a)) p.inserts.splice(r - n, 1);
  const existing = rows.filter((x) => x < n);
  const allMarked = existing.length && existing.every((r) => p.deletes.has(r));
  for (const r of existing) allMarked ? p.deletes.delete(r) : p.deletes.add(r);
  tab.selected.clear();
  renderData(tab);
}

async function applyChanges(tab) {
  if (!tab.isDirty()) return;
  const d = tab.data;
  const p = tab.pending;
  const pkIdx = tab.meta.map((m, i) => (m.pk ? i : -1)).filter((i) => i >= 0);
  const key = (r) => Object.fromEntries(pkIdx.map((i) => [d.columns[i], d.rows[r][i]]));
  const ops = [];
  for (const r of p.deletes) ops.push({ type: 'delete', key: key(r) });
  const edited = [];
  for (const [r, m] of p.edits) {
    if (m.size && !p.deletes.has(r)) {
      ops.push({ type: 'update', key: key(r), changes: Object.fromEntries([...m].map(([c, v]) => [d.columns[c], v])) });
      edited.push(r);
    }
  }
  for (const row of p.inserts) ops.push({ type: 'insert', values: Object.fromEntries(row.map((v, c) => [d.columns[c], v]).filter(([, v]) => v !== DEFAULT)) });
  const b = tab.ui.bApply;
  b.classList.add('loading');
  try {
    const r = await api('POST', `/api/c/${tab.connId}/apply`, { ns: tab.ns, table: tab.table, ops });
    toast(`${r.applied} perubahan · ${r.affected} baris`, 'ok', { title: 'Tersimpan' });
    await loadData(tab);
    tab.flash = new Set(edited);
    if (tab.flash.size) renderData(tab);
  } catch (e) {
    toast(e.message, 'err', { title: 'Gagal menyimpan — transaksi dibatalkan' });
  } finally {
    b.classList.remove('loading');
  }
}

// ---------------------------------------------------------------- other sub-tabs
async function describe(tab) {
  if (!tab.model) tab.model = await api('GET', `/api/c/${tab.connId}/describe${qs({ ns: tab.ns, table: tab.table })}`);
  return tab.model;
}

async function loadStructure(tab, panel) {
  const wrap = panel.querySelector('.grid-wrap');
  if (tab.structureLoaded) return;
  try {
    const m = await describe(tab);
    const fkCols = new Map();
    for (const fk of m.foreignKeys) fk.columns.forEach((c, i) => fkCols.set(c, `${fk.refTable}.${fk.refColumns[i]}`));
    const uniq = new Set(m.indexes.filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0]));
    renderGrid(wrap, {
      columns: ['Kolom', 'Tipe', 'Null', 'Default', 'Kunci', 'Auto', 'Komentar'],
      rows: m.columns.map((c) => [
        c.name,
        c.type,
        c.nullable ? 'YES' : 'NO',
        c.generated ? `= ${c.generated.expr}` : c.default,
        [m.primaryKey.includes(c.name) ? 'PK' : '', fkCols.has(c.name) ? `FK → ${fkCols.get(c.name)}` : '', uniq.has(c.name) ? 'UNIQUE' : ''].filter(Boolean).join(' · '),
        c.autoIncrement ? '✓' : '',
        c.comment || '',
      ]),
      animate: true,
    });
    tab.structureLoaded = true;
  } catch (e) {
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'result-error', text: e.message }));
  }
}

async function loadRelations(tab, panel) {
  const box = panel.querySelector('.scroll-pad');
  box.innerHTML = '';
  box.append(h('div', { class: 'skeleton', style: { height: '120px' } }));
  try {
    const [m, all] = await Promise.all([describe(tab), schemaOf(tab.connId, tab.ns)]);
    const incoming = all.flatMap((t) => t.foreignKeys.filter((fk) => fk.refTable === tab.table).map((fk) => ({ ...fk, from: t.name })));
    const rule = (fk) => [fk.onDelete && fk.onDelete !== 'NO ACTION' ? `ON DELETE ${fk.onDelete}` : '', fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? `ON UPDATE ${fk.onUpdate}` : ''].filter(Boolean).join(' · ');
    const link = (name) => h('a', { href: '#', class: 'mono', text: name, onclick: (e) => (e.preventDefault(), openTableTab(name)) });
    const card = (title, ico, items, empty) =>
      h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'card-title', html: icon(ico) + esc(title) + ` <span class="chip">${items.length}</span>` }), items.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, ...items) : h('div', { class: 'faint', text: empty }));
    box.innerHTML = '';
    box.append(
      h('div', { class: 'row', style: { marginBottom: '14px' } }, h('button', { class: 'btn sm', html: icon('pencil-ruler') + '<span>Ubah di Desain tabel</span>', onclick: () => app.openDesigner(tab.table) }), h('button', { class: 'btn sm', html: icon('workflow') + '<span>Lihat di ERD</span>', onclick: () => app.openTool('erd', { focus: tab.table }) })),
      card('Primary key', 'key-round', m.primaryKey.length ? [h('div', { class: 'mono', text: m.primaryKey.join(', ') })] : [], 'Tidak ada primary key'),
      card(
        'Relasi keluar (foreign key)',
        'arrow-up-right',
        m.foreignKeys.map((fk) => h('div', { class: 'row wrap' }, h('span', { class: 'chip info', text: fk.name }), h('span', { class: 'mono', text: `(${fk.columns.join(', ')}) →` }), link(fk.refTable), h('span', { class: 'mono', text: `(${fk.refColumns.join(', ')})` }), rule(fk) ? h('span', { class: 'chip', text: rule(fk) }) : null)),
        'Tabel ini tidak merujuk tabel lain.',
      ),
      card(
        'Dirujuk oleh',
        'arrow-down-left',
        incoming.map((fk) => h('div', { class: 'row wrap' }, link(fk.from), h('span', { class: 'mono', text: `(${fk.columns.join(', ')}) → (${fk.refColumns.join(', ')})` }), rule(fk) ? h('span', { class: 'chip', text: rule(fk) }) : null)),
        'Tidak ada tabel lain yang merujuk tabel ini.',
      ),
      card(
        'Index',
        'list-ordered',
        m.indexes.map((ix) => h('div', { class: 'row wrap' }, h('span', { class: `chip ${ix.unique ? 'ok' : ''}`, text: ix.unique ? 'UNIQUE' : 'INDEX' }), h('span', { class: 'mono', text: ix.name }), h('span', { class: 'mono faint', text: ix.complex ? ix.def || '(ekspresi)' : `(${ix.columns.join(', ')})` }))),
        'Tidak ada index selain primary key.',
      ),
    );
  } catch (e) {
    box.innerHTML = '';
    box.append(h('div', { class: 'result-error', text: e.message }));
  }
}

async function loadDDL(tab, box) {
  if (tab.ddl != null) return tab.ddlCm?.refresh();
  try {
    const { ddl } = await api('GET', `/api/c/${tab.connId}/ddl${qs({ ns: tab.ns, table: tab.table })}`);
    tab.ddl = ddl;
    tab.ddlCm = createEditor(box, { value: ddl, type: tab.connType, readOnly: true, lineWrapping: true });
  } catch (e) {
    box.append(h('div', { class: 'result-error', text: e.message }));
  }
}

async function loadInfo(tab, panel) {
  const box = panel.querySelector('.scroll-pad');
  box.innerHTML = '';
  try {
    const m = await describe(tab);
    const total = tab.data?.total;
    const dl = h('dl', { class: 'kv' });
    const add = (k, v) => dl.append(h('dt', { text: k }), h('dd', { text: v == null || v === '' ? '–' : String(v) }));
    add('Nama', m.name);
    add(state.active?.conn.type === 'postgres' ? 'Schema' : 'Database', tab.ns);
    add('Jenis', m.kind === 'view' ? 'View' : 'Tabel');
    add('Jumlah baris (pasti)', total != null ? fmtNum(total) : '…');
    add('Estimasi baris (statistik)', m.rowsEstimate != null ? fmtNum(m.rowsEstimate) : null);
    add('Kolom', m.columns.length);
    add('Index', m.indexes.length);
    add('Foreign key', m.foreignKeys.length);
    if (m.engine) add('Engine', m.engine);
    if (m.collation) add('Collation', m.collation);
    add('Komentar', m.comment);
    box.append(h('div', { class: 'card' }, h('div', { class: 'card-title', html: icon('info') + 'Informasi tabel' }), dl));
    const big = h('div', { class: 'count-up', style: { font: '700 34px var(--display)', marginTop: '18px' } });
    box.append(h('div', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'section-label', text: 'Total baris' }), big));
    countUp(big, total || 0, 900);
  } catch (e) {
    box.append(h('div', { class: 'result-error', text: e.message }));
  }
}

Object.assign(app, { openTableTab });
