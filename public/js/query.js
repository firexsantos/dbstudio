// Query tabs: editor, run / run current / explain / format, results grid, history & favorites.
import {
  $, h, icon, esc, api, state, app, on, local, toast, modal, promptDialog, copyText, debounce, clamp, fmtNum,
  statementRanges, createEditor, CM_MODE, TYPE_LABEL, downloadText, timeAgo,
} from './core.js';
import { addTab, activateTab, renderTabs } from './tabs.js';
import { renderGrid, nextSort, cmpValues, toCSV } from './grid.js';
import { formatSQL } from './sqlfmt.js';
import { countUp } from './fx.js';

const saveTabs = debounce(() => {
  local.set(
    'dbs-queries',
    state.tabs.filter((t) => t.kind === 'query' && t.cm).map((t) => ({ title: t.title, sql: t.cm.getValue() })),
  );
}, 300);
on('tabs-changed', saveTabs);

function nextQueryNo() {
  let m = 0;
  for (const t of state.tabs) {
    const x = /^Query (\d+)$/.exec(t.title);
    if (x) m = Math.max(m, Number(x[1]));
  }
  return m + 1;
}

export function newQueryTab(sql = '', runNow = false, title = null, { activate = true } = {}) {
  const panel = h('div');
  const ctx = h('span', { class: 'ctx-pill' });
  const btn = (act, ico, label, tip, kind = '') => h('button', { class: `btn sm ${kind}`, 'data-act': act, title: tip, html: icon(ico) + (label ? `<span>${label}</span>` : '') });
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    btn('run', 'play', 'Jalankan', 'Ctrl+Enter — seleksi, atau seluruh editor', 'primary'),
    btn('run-current', 'text-cursor', 'Statement ini', 'F9 / Ctrl+Shift+Enter'),
    btn('explain', 'scan-search', 'Explain', 'Rencana eksekusi statement di kursor'),
    h('span', { class: 'sep' }),
    btn('format', 'wand-sparkles', 'Rapikan', 'Format SQL (Ctrl+Shift+F)'),
    btn('history', 'history', '', 'Riwayat & favorit'),
    btn('star', 'star', '', 'Simpan sebagai favorit'),
    h('span', { class: 'spacer' }),
    ctx,
    btn('csv', 'file-spreadsheet', 'CSV', 'Ekspor hasil ke CSV'),
    btn('json', 'braces', 'JSON', 'Salin hasil sebagai JSON'),
  );
  const editorWrap = h('div', { class: 'editor-wrap' });
  const split = h('div', { class: 'hsplit', title: 'Seret untuk mengubah ukuran' });
  const results = h('div', { class: 'results' }, emptyResult());
  panel.append(toolbar, editorWrap, split, results);

  const tab = {
    kind: 'query',
    icon: 'square-terminal',
    title: title || `Query ${nextQueryNo()}`,
    panel,
    result: null,
    sort: null,
    shown: 1000,
    onActivate: () => {
      tab.cm?.refresh();
      tab.cm?.focus();
      updateCtx(tab);
    },
    onClose: () => setTimeout(saveTabs),
    rename: async () => {
      const name = await promptDialog({ title: 'Ganti nama tab', label: 'Nama', value: tab.title });
      if (name) {
        tab.title = name;
        renderTabs();
        saveTabs();
      }
    },
  };
  tab.ctx = ctx;
  addTab(tab, { activate });

  const cm = createEditor(editorWrap, {
    value: sql,
    hint: true,
    extraKeys: {
      'Ctrl-Enter': () => runQuery(tab, 'auto'),
      'Cmd-Enter': () => runQuery(tab, 'auto'),
      'Shift-Ctrl-Enter': () => runQuery(tab, 'current'),
      'Shift-Cmd-Enter': () => runQuery(tab, 'current'),
      F9: () => runQuery(tab, 'current'),
      'Shift-Ctrl-F': () => formatTab(tab),
      'Ctrl-Space': 'autocomplete',
    },
  });
  tab.cm = cm;
  cm.on('changes', saveTabs);
  cm.on('inputRead', (ed, change) => {
    if (change.origin !== '+input' || !/^[A-Za-z_.]$/.test(change.text[0])) return;
    const tok = ed.getTokenAt(ed.getCursor());
    if (tok.type === 'string' || tok.type === 'comment') return;
    ed.showHint({ completeSingle: false });
  });
  cm.setCursor(cm.lineCount(), 0);
  if (activate) cm.focus();

  // drag splitter
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    split.classList.add('dragging');
    const move = (ev) => {
      const top = editorWrap.getBoundingClientRect().top;
      editorWrap.style.height = clamp(ev.clientY - top, 90, panel.clientHeight - 140) + 'px';
      cm.refresh();
    };
    const up = () => {
      split.classList.remove('dragging');
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });

  const act = (n) => toolbar.querySelector(`[data-act="${n}"]`);
  act('run').onclick = () => runQuery(tab, 'auto');
  act('run-current').onclick = () => runQuery(tab, 'current');
  act('explain').onclick = () => runQuery(tab, 'explain');
  act('format').onclick = () => formatTab(tab);
  act('history').onclick = () => openHistory(tab);
  act('star').onclick = () => saveFavorite(tab);
  act('csv').onclick = () => tab.result && downloadText(tab.title.replace(/[^\w.-]+/g, '_') + '.csv', toCSV(tab.result.columns, sortedRows(tab)), 'text/csv');
  act('json').onclick = () => tab.result && copyText(JSON.stringify(sortedRows(tab).map((r) => Object.fromEntries(tab.result.columns.map((c, i) => [c, r[i]]))), null, 2));
  setExportEnabled(tab);
  updateCtx(tab);
  saveTabs();
  if (runNow) runQuery(tab, 'auto');
  return tab;
}

function emptyResult() {
  return h('div', { class: 'empty', style: { flex: 1 } }, h('div', { html: icon('sparkles') }), h('div', { html: 'Tulis SQL lalu tekan <kbd>Ctrl</kbd> + <kbd>Enter</kbd>' }));
}

function updateCtx(tab) {
  const a = state.active;
  tab.ctx.innerHTML = a
    ? `${icon('database')} ${esc(a.conn.name)}${a.conn.type !== 'sqlite' ? ' / ' + esc(a.ns) : ''}`
    : `${icon('unplug')} tidak terhubung`;
  tab.cm?.setOption('mode', CM_MODE[a?.conn.type || 'mysql']);
}
on('connected', () => state.tabs.filter((t) => t.kind === 'query').forEach(updateCtx));
on('ns', () => state.tabs.filter((t) => t.kind === 'query').forEach(updateCtx));
on('tree', () => state.tabs.filter((t) => t.kind === 'query').forEach((t) => t.cm?.setOption('hintOptions', { tables: state.columns, completeSingle: false })));

function setExportEnabled(tab) {
  const has = Boolean(tab.result?.columns?.length);
  tab.panel.querySelector('[data-act="csv"]').disabled = !has;
  tab.panel.querySelector('[data-act="json"]').disabled = !has;
}

function formatTab(tab) {
  const cm = tab.cm;
  if (cm.somethingSelected()) cm.replaceSelection(formatSQL(cm.getSelection()));
  else cm.setValue(formatSQL(cm.getValue()));
  toast('SQL dirapikan', 'ok', { timeout: 1400 });
}

function statementAtCursor(cm) {
  const text = cm.getValue();
  const pos = cm.indexFromPos(cm.getCursor());
  const ranges = statementRanges(text);
  const r = ranges.find((x) => pos >= x.start && pos <= x.end + 1) || [...ranges].reverse().find((x) => x.end < pos) || ranges[0];
  if (!r) return '';
  const lead = text.slice(r.start, r.end).search(/\S/);
  const mark = cm.markText(cm.posFromIndex(r.start + lead), cm.posFromIndex(r.end), { className: 'cm-run-flash' });
  setTimeout(() => mark.clear(), 800);
  return text.slice(r.start, r.end).trim();
}

function sortedRows(tab) {
  const rows = tab.result.rows;
  if (!tab.sort) return rows;
  const { col, dir } = tab.sort;
  return [...rows].sort((x, y) => (dir === 'desc' ? -1 : 1) * cmpValues(x[col], y[col]));
}

export async function runQuery(tab, mode) {
  const a = state.active;
  if (!a) {
    toast('Pilih koneksi di panel kiri terlebih dahulu.', 'err', { title: 'Belum terhubung' });
    app.showPanel('connections');
    return;
  }
  const cm = tab.cm;
  let sql = mode === 'auto' ? (cm.somethingSelected() ? cm.getSelection() : cm.getValue()) : statementAtCursor(cm);
  if (!sql.trim()) return toast('Tidak ada SQL untuk dijalankan', 'err');
  if (mode === 'explain') sql = (a.conn.type === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ') + sql.replace(/;\s*$/, '');
  const res = tab.panel.querySelector('.results');
  const wrap = tab.panel.querySelector('.editor-wrap');
  const runBtn = tab.panel.querySelector('[data-act="run"]');
  wrap.classList.add('running');
  runBtn.classList.add('loading');
  runBtn.innerHTML = icon('loader-circle') + '<span>Berjalan…</span>';
  const t0 = performance.now();
  try {
    const r = await api('POST', `/api/c/${a.conn.id}/query`, { sql, ns: a.ns });
    tab.result = r;
    tab.sort = null;
    tab.shown = 1000;
    renderResult(tab, true);
    addHistory({ sql, conn: a.conn.name, connId: a.conn.id, ns: a.conn.type === 'sqlite' ? null : a.ns, ok: true, ms: r.ms, rows: r.columns.length ? r.rows.length : r.affected });
    if (/^\s*(create|drop|alter|rename|truncate)\b/im.test(sql)) app.loadTree();
  } catch (e) {
    tab.result = null;
    res.innerHTML = '';
    res.append(h('div', { class: 'result-error', text: e.message }));
    addHistory({ sql, conn: a.conn.name, connId: a.conn.id, ns: a.conn.type === 'sqlite' ? null : a.ns, ok: false, error: e.message, ms: Math.round(performance.now() - t0) });
  } finally {
    wrap.classList.remove('running');
    runBtn.classList.remove('loading');
    runBtn.innerHTML = icon('play') + '<span>Jalankan</span>';
    setExportEnabled(tab);
  }
}

function renderResult(tab, fresh = false) {
  const r = tab.result;
  const res = tab.panel.querySelector('.results');
  res.innerHTML = '';
  const status = h('div', { class: 'result-status' });
  const multi = r.statements > 1 ? `<span class="chip">${icon('layers')} ${r.statements} statement · hasil terakhir</span>` : '';
  if (!r.columns.length) {
    status.innerHTML = `<span class="chip ok">${icon('check')} ${esc(r.command || 'OK')}</span><span class="chip"><b class="count-up">0</b>&nbsp;baris terpengaruh</span>${
      r.insertId ? `<span class="chip">insert id ${esc(r.insertId)}</span>` : ''
    }<span class="chip">${icon('timer')} ${r.ms} ms</span>${multi}`;
    res.append(status, h('div', { class: 'empty', style: { flex: 1 } }, h('div', { html: icon('circle-check-big') }), h('div', { text: 'Query berhasil dijalankan.' })));
    countUp(status.querySelector('.count-up'), r.affected ?? 0);
    return;
  }
  status.innerHTML = `<span class="chip ok">${icon('check')} <b class="count-up">0</b>&nbsp;baris</span><span class="chip">${icon('columns-3')} ${r.columns.length} kolom</span><span class="chip">${icon('timer')} ${r.ms} ms</span>${multi}`;
  const gw = h('div', { class: 'grid-wrap' });
  res.append(status, gw);
  countUp(status.querySelector('.count-up'), r.rows.length);
  renderGrid(gw, {
    columns: r.columns,
    rows: sortedRows(tab),
    sort: tab.sort,
    limit: tab.shown,
    animate: fresh,
    onMore: () => {
      tab.shown += 2000;
      renderResult(tab);
    },
    onSort: (i) => {
      tab.sort = nextSort(tab.sort, i);
      renderResult(tab);
    },
  });
}

// ---------------------------------------------------------------- history & favorites
function addHistory(entry) {
  const list = local.get('dbs-history', []);
  list.unshift({ ...entry, at: Date.now() });
  local.set('dbs-history', list.slice(0, 300));
}

async function saveFavorite(tab) {
  const sql = tab.cm.somethingSelected() ? tab.cm.getSelection() : tab.cm.getValue();
  if (!sql.trim()) return toast('Editor kosong', 'err');
  const name = await promptDialog({ title: 'Simpan ke favorit', label: 'Nama query', value: tab.title, icon: 'star' });
  if (!name) return;
  const favs = local.get('dbs-favorites', []);
  favs.unshift({ name, sql, at: Date.now(), type: state.active?.conn.type });
  local.set('dbs-favorites', favs.slice(0, 200));
  toast(`"${name}" disimpan ke favorit`, 'ok');
}

function insertSql(tab, sql) {
  const cm = tab.cm;
  const cur = cm.getValue();
  cm.setValue(cur.trim() ? cur.replace(/\s*$/, '\n\n') + sql : sql);
  activateTab(tab.id);
  cm.setCursor(cm.lineCount(), 0);
}

export function openHistory(tab) {
  let which = 'history';
  let q = '';
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minHeight: '300px' } });
  const search = h('input', { class: 'input', placeholder: 'Cari SQL…' });
  const seg = h('div', { class: 'seg' });
  const render = () => {
    list.innerHTML = '';
    const items = (which === 'history' ? local.get('dbs-history', []) : local.get('dbs-favorites', [])).filter((x) => !q || (x.sql + ' ' + (x.name || '')).toLowerCase().includes(q));
    if (!items.length) {
      list.append(h('div', { class: 'empty', html: `${icon(which === 'history' ? 'history' : 'star')}<div>${which === 'history' ? 'Belum ada riwayat.' : 'Belum ada favorit — klik ⭐ di toolbar query.'}</div>` }));
      return;
    }
    items.slice(0, 150).forEach((x, i) => {
      const meta =
        which === 'history'
          ? `${esc(timeAgo(x.at))} · ${esc(x.conn)}${x.ns ? ' / ' + esc(x.ns) : ''} · ${x.ok ? `<span class="chip ok">${x.ms} ms</span>` : `<span class="chip danger">error</span> <span class="faint">${esc(String(x.error).slice(0, 90))}</span>`}`
          : `<b>${esc(x.name)}</b> · ${esc(timeAgo(x.at))}`;
      const item = h('div', { class: 'history-item', style: { '--i': i } }, h('div', { class: 'h-sql', text: x.sql }), h('div', { class: 'h-meta', html: meta }));
      item.onclick = () => {
        m.close();
        if (state.tabs.includes(tab)) insertSql(tab, x.sql);
        else newQueryTab(x.sql);
      };
      item.oncontextmenu = (e) => {
        e.preventDefault();
        if (which !== 'favorites') return;
        const favs = local.get('dbs-favorites', []).filter((f) => f.at !== x.at);
        local.set('dbs-favorites', favs);
        render();
      };
      list.append(item);
    });
  };
  for (const [v, label, ico] of [['history', 'Riwayat', 'history'], ['favorites', 'Favorit', 'star']]) {
    const b = h('button', { class: v === which ? 'active' : '', html: icon(ico) + label });
    b.onclick = () => {
      which = v;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      render();
    };
    seg.append(b);
  }
  search.oninput = () => {
    q = search.value.toLowerCase();
    render();
  };
  const m = modal({
    title: 'Riwayat & favorit',
    sub: 'Klik untuk menyisipkan ke editor · klik kanan favorit untuk menghapus',
    icon: 'history',
    size: 'wide',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, h('div', { class: 'row' }, seg, h('div', { class: 'search grow', html: icon('search') }, search)), list),
    actions: [
      {
        label: 'Hapus riwayat',
        kind: 'ghost danger',
        icon: 'trash-2',
        onClick: () => {
          local.set('dbs-history', []);
          render();
          return false;
        },
      },
      'spacer',
      { label: 'Tutup' },
    ],
  });
  render();
}

export function restoreQueryTabs() {
  const saved = local.get('dbs-queries', []);
  saved.forEach((q, i) => newQueryTab(q.sql, false, q.title, { activate: i === 0 }));
}

Object.assign(app, { newQueryTab, runQuery });
void $;
void fmtNum;
void TYPE_LABEL;
