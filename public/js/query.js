// Query tabs: editor, run / run current / explain / format, results grid, history & favorites.
import {
  $, h, icon, esc, api, state, app, on, local, wsById, toast, modal, promptDialog, copyText, debounce, clamp, fmtNum,
  statementRanges, createEditor, CM_MODE, TYPE_LABEL, downloadText, timeAgo, segmented,
} from './core.js';
import { addTab, activateTab, renderTabs } from './tabs.js';
import { renderGrid, nextSort, cmpValues, toCSV } from './grid.js';
import { formatSQL } from './sqlfmt.js';
import { mountChart } from './charts.js';
import { exportMenu } from './exporters.js';
import { countUp } from './fx.js';
import { t, plural } from './i18n.js';

const saveTabs = debounce(() => {
  local.set(
    'dbs-queries',
    state.tabs.filter((x) => x.kind === 'query' && x.cm).map((x) => ({ title: x.title, sql: x.cm.getValue(), ws: x.ws })),
  );
}, 300);
on('tabs-changed', saveTabs);

function nextQueryNo() {
  let m = 0;
  for (const tab of state.tabs) {
    const x = /^Query (\d+)$/.exec(tab.title);
    if (x) m = Math.max(m, Number(x[1]));
  }
  return m + 1;
}

export function newQueryTab(sql = '', runNow = false, title = null, { activate = true, ws } = {}) {
  const panel = h('div');
  const ctx = h('span', { class: 'ctx-pill' });
  const btn = (act, ico, label, tip, kind = '') => h('button', { class: `btn sm ${kind}`, 'data-act': act, title: tip, html: icon(ico) + (label ? `<span>${label}</span>` : '') });
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    btn('run', 'play', t('Run'), t('Ctrl+Enter — selection, or the whole editor'), 'primary'),
    btn('run-current', 'text-cursor', t('This statement'), 'F9 / Ctrl+Shift+Enter'),
    btn('explain', 'scan-search', t('Explain'), t('Execution plan for the statement at the cursor')),
    h('span', { class: 'sep' }),
    btn('format', 'wand-sparkles', t('Tidy'), t('Format SQL (Ctrl+Shift+F)')),
    btn('history', 'history', '', t('History & favorites')),
    btn('star', 'star', '', t('Save as favorite')),
    h('span', { class: 'spacer' }),
    ctx,
    btn('export', 'download', t('Export'), 'Excel, CSV, JSON, Markdown, HTML, SQL'),
  );
  const editorWrap = h('div', { class: 'editor-wrap' });
  const split = h('div', { class: 'hsplit', title: t('Drag to resize') });
  const results = h('div', { class: 'results' }, emptyResult());
  panel.append(toolbar, editorWrap, split, results);

  const tab = {
    ws, // undefined → the workspace on screen
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
      tab.cm?.setOption('hintOptions', { tables: wsOf(tab)?.columns || {}, completeSingle: false });
    },
    onClose: () => setTimeout(saveTabs),
    rename: async () => {
      const name = await promptDialog({ title: t('Rename tab'), label: t('Name'), value: tab.title });
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
  act('export').onclick = (e) => tab.result && exportMenu(e, { columns: tab.result.columns, rows: sortedRows(tab), name: tab.title, type: state.active?.conn.type });
  setExportEnabled(tab);
  updateCtx(tab);
  saveTabs();
  if (runNow) runQuery(tab, 'auto');
  return tab;
}

function emptyResult() {
  return h('div', { class: 'empty', style: { flex: 1 } }, h('div', { html: icon('sparkles') }), h('div', { html: t('Write SQL, then press <kbd>Ctrl</kbd> + <kbd>Enter</kbd>') }));
}

// The connection a query tab runs against: its own workspace.
const wsOf = (tab) => wsById(tab.ws) || state.active;

function updateCtx(tab) {
  const a = wsOf(tab);
  tab.ctx.innerHTML = a
    ? `${icon('database')} ${esc(a.conn.name)}${a.conn.type !== 'sqlite' ? ' / ' + esc(a.ns) : ''}`
    : `${icon('unplug')} ${t('not connected')}`;
  tab.cm?.setOption('mode', CM_MODE[a?.conn.type || 'mysql']);
}
const mine = () => state.tabs.filter((x) => x.kind === 'query' && x.ws === state.ws);
on('connected', () => mine().forEach(updateCtx));
on('ns', () => mine().forEach(updateCtx));
on('tree', () => mine().forEach((x) => x.cm?.setOption('hintOptions', { tables: state.columns, completeSingle: false })));

function setExportEnabled(tab) {
  const has = Boolean(tab.result?.columns?.length);
  tab.panel.querySelector('[data-act="export"]').disabled = !has;
}

function formatTab(tab) {
  const cm = tab.cm;
  if (cm.somethingSelected()) cm.replaceSelection(formatSQL(cm.getSelection()));
  else cm.setValue(formatSQL(cm.getValue()));
  toast(t('SQL formatted'), 'ok', { timeout: 1400 });
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
  const a = wsOf(tab);
  if (!a) {
    toast(t('Pick a connection in the left panel first.'), 'err', { title: t('Not connected') });
    app.showPanel('connections');
    return;
  }
  const cm = tab.cm;
  let sql = mode === 'auto' ? (cm.somethingSelected() ? cm.getSelection() : cm.getValue()) : statementAtCursor(cm);
  if (!sql.trim()) return toast(t('No SQL to run'), 'err');
  if (mode === 'explain') sql = (a.conn.type === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ') + sql.replace(/;\s*$/, '');
  const res = tab.panel.querySelector('.results');
  const wrap = tab.panel.querySelector('.editor-wrap');
  const runBtn = tab.panel.querySelector('[data-act="run"]');
  wrap.classList.add('running');
  runBtn.classList.add('loading');
  runBtn.innerHTML = icon('loader-circle') + `<span>${t('Running…')}</span>`;
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
    runBtn.innerHTML = icon('play') + `<span>${t('Run')}</span>`;
    setExportEnabled(tab);
  }
}

const COUNT = '<b class="count-up">0</b>';

function renderResult(tab, fresh = false) {
  const r = tab.result;
  const res = tab.panel.querySelector('.results');
  res.innerHTML = '';
  const status = h('div', { class: 'result-status' });
  const multi = r.statements > 1 ? `<span class="chip">${icon('layers')} ${plural(r.statements, '{n} statement · last result', '{n} statements · last result')}</span>` : '';
  if (!r.columns.length) {
    status.innerHTML = `<span class="chip ok">${icon('check')} ${esc(r.command || 'OK')}</span><span class="chip">${plural(r.affected ?? 0, '{count}&nbsp;row affected', '{count}&nbsp;rows affected', { count: COUNT })}</span>${
      r.insertId ? `<span class="chip">insert id ${esc(r.insertId)}</span>` : ''
    }<span class="chip">${icon('timer')} ${r.ms} ms</span>${multi}`;
    res.append(status, h('div', { class: 'empty', style: { flex: 1 } }, h('div', { html: icon('circle-check-big') }), h('div', { text: t('Query ran successfully.') })));
    countUp(status.querySelector('.count-up'), r.affected ?? 0);
    return;
  }
  status.innerHTML = `<span class="chip ok">${icon('check')} ${plural(r.rows.length, '{count}&nbsp;row', '{count}&nbsp;rows', { count: COUNT })}</span><span class="chip">${icon('columns-3')} ${plural(r.columns.length, '{n} column', '{n} columns')}</span><span class="chip">${icon('timer')} ${r.ms} ms</span>${multi}<span class="spacer"></span>`;
  const viewSeg = segmented(
    [
      { value: 'grid', label: t('Table'), icon: 'table' },
      { value: 'chart', label: t('Chart'), icon: 'chart-column' },
    ],
    tab.view || 'grid',
    (v) => {
      tab.view = v;
      renderResult(tab, v === 'grid');
    },
  );
  status.append(viewSeg);
  const gw = h('div', { class: 'grid-wrap' });
  res.append(status, gw);
  countUp(status.querySelector('.count-up'), r.rows.length);
  if (tab.view === 'chart') {
    gw.classList.add('chart-host');
    mountChart(gw, { columns: r.columns, rows: sortedRows(tab), title: tab.title });
    return;
  }
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
  if (!sql.trim()) return toast(t('The editor is empty'), 'err');
  const name = await promptDialog({ title: t('Save to favorites'), label: t('Query name'), value: tab.title, icon: 'star' });
  if (!name) return;
  const favs = local.get('dbs-favorites', []);
  favs.unshift({ name, sql, at: Date.now(), type: state.active?.conn.type });
  local.set('dbs-favorites', favs.slice(0, 200));
  toast(t('"{name}" saved to favorites', { name }), 'ok');
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
  const search = h('input', { class: 'input', placeholder: t('Search SQL…') });
  const seg = h('div', { class: 'seg' });
  const render = () => {
    list.innerHTML = '';
    const items = (which === 'history' ? local.get('dbs-history', []) : local.get('dbs-favorites', [])).filter((x) => !q || (x.sql + ' ' + (x.name || '')).toLowerCase().includes(q));
    if (!items.length) {
      list.append(h('div', { class: 'empty', html: `${icon(which === 'history' ? 'history' : 'star')}<div>${which === 'history' ? t('No history yet.') : t('No favorites yet — click ⭐ in the query toolbar.')}</div>` }));
      return;
    }
    items.slice(0, 150).forEach((x, i) => {
      const meta =
        which === 'history'
          ? `${esc(timeAgo(x.at))} · ${esc(x.conn)}${x.ns ? ' / ' + esc(x.ns) : ''} · ${x.ok ? `<span class="chip ok">${x.ms} ms</span>` : `<span class="chip danger">${t('error')}</span> <span class="faint">${esc(String(x.error).slice(0, 90))}</span>`}`
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
  for (const [v, label, ico] of [['history', t('History'), 'history'], ['favorites', t('Favorites'), 'star']]) {
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
    title: t('History & favorites'),
    sub: t('Click to insert into the editor · right-click a favorite to delete it'),
    icon: 'history',
    size: 'wide',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, h('div', { class: 'row' }, seg, h('div', { class: 'search grow', html: icon('search') }, search)), list),
    actions: [
      {
        label: t('Clear history'),
        kind: 'ghost danger',
        icon: 'trash-2',
        onClick: () => {
          local.set('dbs-history', []);
          render();
          return false;
        },
      },
      'spacer',
      { label: t('Close') },
    ],
  });
  render();
}

export function restoreQueryTabs() {
  const saved = local.get('dbs-queries', []);
  // Tabs go back to their workspace once it reconnects; until then (or if it can't) they are adopted by another.
  saved.forEach((q) => newQueryTab(q.sql, false, q.title, { activate: false, ws: q.ws ?? null }));
}

Object.assign(app, { newQueryTab, runQuery });
void $;
void fmtNum;
void TYPE_LABEL;
