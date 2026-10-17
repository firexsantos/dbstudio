// Visual Query Builder (Navicat-style): tables on a canvas, joins from foreign keys or drag column→column,
// a criteria grid (output, alias, aggregate, sort, filter) and live SQL in the active dialect.
import { $, h, icon, esc, api, state, app, toast, showMenu, select, toggle, createEditor, quoteIdent, clamp } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { schemaOf } from './table.js';
import { renderGrid } from './grid.js';
import { formatSQL } from './sqlfmt.js';
import { motionOK } from './fx.js';
import { t, plural } from './i18n.js';

const W = 220;
const HEAD = 36;
const ROW = 24;
const AGGS = ['', 'COUNT', 'COUNT DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'];
const JOINS = ['INNER', 'LEFT', 'RIGHT'];
let uid = 0;

export async function openQueryBuilder() {
  const a = state.active;
  if (!a) return;
  const prev = findTab((t) => t.kind === 'qb' && t.connId === a.conn.id && t.ns === a.ns);
  if (prev) return activateTab(prev.id);
  const type = a.conn.type;
  const Q = (s) => quoteIdent(s, type);
  let models;
  try {
    models = (await schemaOf(a.conn.id, a.ns)).filter((m) => m.kind === 'table' || m.kind === 'view');
  } catch (e) {
    return toast(e.message, 'err');
  }
  const st = { inst: [], joins: [], rows: [], distinct: false, limit: 100 };
  const modelOf = (name) => models.find((m) => m.name === name);

  // ---------------------------------------------------------------- layout
  const panel = h('div', { class: 'qb' });
  const search = h('input', { class: 'input sm', placeholder: t('Search tables…') });
  const tlist = h('div', { class: 'qb-tlist' });
  const canvas = h('div', { class: 'qb-canvas' });
  const world = h('div', { class: 'qb-world' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('qb-links');
  world.append(svg);
  canvas.append(world, h('div', { class: 'qb-hint', html: `${icon('mouse-pointer-click')} ${t('Click or drag tables from the left · drag a column ● onto another column to JOIN · click a line to change the JOIN type')}` }));
  const distinct = toggle('DISTINCT', false, (v) => ((st.distinct = v), update()));
  const limit = h('input', { class: 'input sm', type: 'number', min: 0, value: st.limit, style: { width: '84px' }, title: t('LIMIT (0 = no limit)') });
  limit.oninput = () => ((st.limit = Math.max(0, Number(limit.value) || 0)), update());
  const runBtn = h('button', { class: 'btn sm primary', html: icon('play') + `<span>${t('Run')}</span>` });
  const toQuery = h('button', { class: 'btn sm', html: icon('square-terminal') + `<span>${t('Open in Query')}</span>` });
  const clearBtn = h('button', { class: 'btn sm ghost', html: icon('eraser') + `<span>${t('Clear')}</span>` });
  const bTabs = h('div', { class: 'qb-btabs' });
  const gridBox = h('div', { class: 'qb-criteria' });
  const sqlBox = h('div', { class: 'code-box', style: { margin: 0, borderRadius: 0, border: 0 } });
  const resBox = h('div', { class: 'grid-wrap' });
  const bottomBody = h('div', { class: 'qb-bbody' }, gridBox, sqlBox, resBox);
  const split = h('div', { class: 'hsplit' });
  const bottom = h('div', { class: 'qb-bottom' }, h('div', { class: 'toolbar' }, bTabs, h('span', { class: 'spacer' }), distinct, h('span', { class: 'faint', text: 'LIMIT' }), limit, clearBtn, toQuery, runBtn), bottomBody);
  panel.append(h('div', { class: 'qb-top' }, h('div', { class: 'qb-side' }, h('div', { class: 'search', html: icon('search') }, search), tlist), canvas), split, bottom);
  const tab = { kind: 'qb', icon: 'blocks', title: 'Query Builder', panel, connId: a.conn.id, ns: a.ns, onActivate: () => tab.sqlCm?.refresh() };
  addTab(tab);
  const sqlCm = createEditor(sqlBox, { type, readOnly: true, lineWrapping: true });
  tab.sqlCm = sqlCm;

  let view = 'criteria';
  const VIEWS = [
    ['criteria', t('Columns & criteria'), 'list-filter'],
    ['sql', 'SQL', 'code-xml'],
    ['result', t('Results'), 'table'],
  ];
  for (const [k, label, ico] of VIEWS) {
    const b = h('button', { class: 'subtab', 'data-v': k, html: icon(ico) + label });
    b.onclick = () => setView(k);
    bTabs.append(b);
  }
  function setView(k) {
    view = k;
    bTabs.querySelectorAll('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.v === k));
    gridBox.hidden = k !== 'criteria';
    sqlBox.hidden = k !== 'sql';
    resBox.hidden = k !== 'result';
    if (k === 'sql') setTimeout(() => sqlCm.refresh(), 20);
  }
  setView('criteria');

  // drag splitter between canvas and bottom panel
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = panel.getBoundingClientRect();
      bottom.style.height = clamp(r.bottom - ev.clientY, 160, r.height - 160) + 'px';
      sqlCm.refresh();
    };
    const up = () => (split.removeEventListener('pointermove', move), split.removeEventListener('pointerup', up));
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });

  // ---------------------------------------------------------------- table list
  function renderList() {
    const q = search.value.trim().toLowerCase();
    tlist.innerHTML = '';
    models
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .forEach((m, i) => {
        const used = st.inst.some((x) => x.table === m.name);
        const it = h('div', { class: 'qb-titem' + (used ? ' used' : ''), draggable: 'true', style: { '--i': i } }, h('span', { html: icon(m.kind === 'view' ? 'eye' : 'table-2') }), h('span', { class: 'mono', text: m.name }), h('span', { class: 'faint', text: String(m.columns.length) }));
        it.onclick = () => addInstance(m.name);
        it.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-qb-table', m.name));
        tlist.append(it);
      });
  }
  search.oninput = renderList;
  canvas.addEventListener('dragover', (e) => e.dataTransfer.types.includes('text/x-qb-table') && e.preventDefault());
  canvas.addEventListener('drop', (e) => {
    const name = e.dataTransfer.getData('text/x-qb-table');
    if (!name) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    addInstance(name, { x: e.clientX - r.left + canvas.scrollLeft - W / 2, y: e.clientY - r.top + canvas.scrollTop - 16 });
  });

  // ---------------------------------------------------------------- instances
  function aliasFor(table) {
    const n = st.inst.filter((x) => x.table === table).length;
    return n ? `${table}_${n + 1}` : table;
  }
  function addInstance(table, pos) {
    const m = modelOf(table);
    if (!m) return;
    const id = ++uid;
    const p = pos || { x: 40 + (st.inst.length % 4) * (W + 70), y: 30 + Math.floor(st.inst.length / 4) * 260 };
    const inst = { id, table, alias: aliasFor(table), x: Math.max(10, p.x), y: Math.max(10, p.y) };
    // automatic joins along foreign keys, both directions
    for (const other of st.inst) {
      const om = modelOf(other.table);
      for (const fk of m.foreignKeys) if (fk.refTable === other.table) st.joins.push({ id: ++uid, a: { inst: id, col: fk.columns[0] }, b: { inst: other.id, col: fk.refColumns[0] }, type: 'INNER', auto: true });
      for (const fk of om.foreignKeys) if (fk.refTable === table) st.joins.push({ id: ++uid, a: { inst: other.id, col: fk.columns[0] }, b: { inst: id, col: fk.refColumns[0] }, type: 'INNER', auto: true });
    }
    st.inst.push(inst);
    renderCanvas(id);
    renderList();
    update();
  }
  function removeInstance(id) {
    st.inst = st.inst.filter((x) => x.id !== id);
    st.joins = st.joins.filter((j) => j.a.inst !== id && j.b.inst !== id);
    st.rows = st.rows.filter((r) => r.inst !== id);
    renderCanvas();
    renderList();
    update();
  }
  const instOf = (id) => st.inst.find((x) => x.id === id);
  const rowFor = (inst, col) => st.rows.find((r) => r.inst === inst && r.col === col);
  function toggleColumn(inst, col, on) {
    if (on && !rowFor(inst, col)) st.rows.push({ id: ++uid, inst, col, output: true, alias: '', agg: '', sort: '', filter: '' });
    if (!on) st.rows = st.rows.filter((r) => !(r.inst === inst && r.col === col));
    update();
  }

  function renderCanvas(popId) {
    world.querySelectorAll('.qb-table').forEach((e) => e.remove());
    for (const inst of st.inst) {
      const m = modelOf(inst.table);
      const fkCols = new Set(m.foreignKeys.flatMap((f) => f.columns));
      const allOn = m.columns.every((c) => rowFor(inst.id, c.name));
      const card = h(
        'div',
        { class: 'qb-table' + (inst.id === popId && motionOK() ? ' pop' : ''), style: { left: inst.x + 'px', top: inst.y + 'px' }, 'data-id': inst.id },
        h(
          'div',
          { class: 'qbt-head' },
          h('span', { html: icon(m.kind === 'view' ? 'eye' : 'table-2') }),
          h('span', { class: 'qbt-name', text: inst.alias !== inst.table ? `${inst.table} (${inst.alias})` : inst.table }),
          h('button', { class: 'btn ghost xs icon', title: allOn ? t('Deselect all') : t('Select all columns'), html: icon(allOn ? 'square-minus' : 'square-check-big'), onclick: () => (m.columns.forEach((c) => toggleColumn(inst.id, c.name, !allOn)), renderCanvas()) }),
          h('button', { class: 'btn ghost xs icon', title: t('Remove from query'), html: icon('x'), onclick: () => removeInstance(inst.id) }),
        ),
      );
      for (const c of m.columns) {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = Boolean(rowFor(inst.id, c.name));
        cb.onchange = () => toggleColumn(inst.id, c.name, cb.checked);
        card.append(
          h(
            'label',
            { class: 'qbt-col' + (m.primaryKey.includes(c.name) ? ' pk' : '') + (fkCols.has(c.name) ? ' fk' : ''), 'data-c': c.name },
            cb,
            h('span', { class: 'cn', text: c.name }),
            h('span', { class: 'ct', text: String(c.type).replace(/character varying/i, 'varchar').slice(0, 14) }),
            h('span', { class: 'port', title: t('Drag onto a column of another table to JOIN') }),
          ),
        );
      }
      wireCard(card, inst);
      world.append(card);
    }
    drawLinks();
    canvas.classList.toggle('empty', !st.inst.length);
  }

  function colY(inst, col) {
    const card = world.querySelector(`.qb-table[data-id="${inst.id}"]`);
    const row = card?.querySelector(`.qbt-col[data-c="${CSS.escape(col)}"]`);
    return inst.y + (row ? row.offsetTop + ROW / 2 : HEAD / 2);
  }
  function path(j) {
    const A = instOf(j.a.inst);
    const B = instOf(j.b.inst);
    const y1 = colY(A, j.a.col);
    const y2 = colY(B, j.b.col);
    const right = A.x + W / 2 < B.x + W / 2;
    const x1 = right ? A.x + W : A.x;
    const x2 = right ? B.x : B.x + W;
    const d = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + (right ? d : -d)} ${y1}, ${x2 + (right ? -d : d)} ${y2}, ${x2} ${y2}`;
  }
  function drawLinks() {
    let w = 1200;
    let hgt = 700;
    for (const i of st.inst) {
      w = Math.max(w, i.x + W + 200);
      hgt = Math.max(hgt, i.y + 600);
    }
    world.style.width = w + 'px';
    world.style.height = hgt + 'px';
    svg.setAttribute('width', w);
    svg.setAttribute('height', hgt);
    svg.innerHTML = '<defs><linearGradient id="qb-g" x1="0" x2="1"><stop offset="0" stop-color="#8b5cff"/><stop offset="1" stop-color="#2dffb3"/></linearGradient></defs>';
    for (const j of st.joins) {
      if (!instOf(j.a.inst) || !instOf(j.b.inst)) continue;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const d = path(j);
      g.innerHTML = `<path class="hit" d="${d}"/><path class="link ${j.type.toLowerCase()}" d="${d}"/><path class="flow" d="${d}"/>`;
      const mid = g.querySelector('.link');
      g.addEventListener('click', (e) => joinMenu(e, j));
      svg.append(g);
      const len = mid.getTotalLength();
      const p = mid.getPointAtLength(len / 2);
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      badge.classList.add('jbadge');
      badge.innerHTML = `<rect x="${p.x - 24}" y="${p.y - 10}" rx="9" width="48" height="20"/><text x="${p.x}" y="${p.y + 4}">${j.type}</text>`;
      badge.addEventListener('click', (e) => joinMenu(e, j));
      svg.append(badge);
    }
  }
  function joinMenu(e, j) {
    const A = instOf(j.a.inst);
    const B = instOf(j.b.inst);
    showMenu(e, [
      { label: `${A.alias}.${j.a.col} = ${B.alias}.${j.b.col}`, header: true },
      ...JOINS.map((t) => ({ label: `${t} JOIN`, icon: t === j.type ? 'check' : 'circle', action: () => ((j.type = t), drawLinks(), update()) })),
      { label: t('Swap direction'), icon: 'arrow-left-right', action: () => (([j.a, j.b] = [j.b, j.a]), drawLinks(), update()) },
      '-',
      { label: t('Remove JOIN'), icon: 'unlink', danger: true, action: () => ((st.joins = st.joins.filter((x) => x !== j)), drawLinks(), update()) },
    ]);
  }

  function wireCard(card, inst) {
    const head = card.querySelector('.qbt-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.btn')) return;
      head.setPointerCapture(e.pointerId);
      const s = { x: e.clientX, y: e.clientY, ix: inst.x, iy: inst.y };
      card.classList.add('drag');
      const move = (ev) => {
        inst.x = Math.max(4, s.ix + ev.clientX - s.x);
        inst.y = Math.max(4, s.iy + ev.clientY - s.y);
        card.style.left = inst.x + 'px';
        card.style.top = inst.y + 'px';
        drawLinks();
      };
      const up = () => (card.classList.remove('drag'), head.removeEventListener('pointermove', move), head.removeEventListener('pointerup', up));
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    card.querySelectorAll('.port').forEach((port) => port.addEventListener('click', (e) => e.preventDefault()));
    card.querySelectorAll('.port').forEach((port) =>
      port.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const col = port.closest('.qbt-col').dataset.c;
        const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        temp.classList.add('temp');
        svg.append(temp);
        const wr = world.getBoundingClientRect();
        const x1 = inst.x + W;
        const y1 = colY(inst, col);
        let target = null;
        const move = (ev) => {
          const x = ev.clientX - wr.left;
          const y = ev.clientY - wr.top;
          temp.setAttribute('d', `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x - 60} ${y}, ${x} ${y}`);
          const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.qbt-col');
          if (target && target !== el) target.classList.remove('drop');
          target = el && el.closest('.qb-table').dataset.id !== String(inst.id) ? el : null;
          target?.classList.add('drop');
        };
        const up = () => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          temp.remove();
          if (target) {
            target.classList.remove('drop');
            st.joins.push({ id: ++uid, a: { inst: inst.id, col }, b: { inst: Number(target.closest('.qb-table').dataset.id), col: target.dataset.c }, type: 'INNER' });
            drawLinks();
            update();
          }
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
      }),
    );
  }

  // ---------------------------------------------------------------- SQL
  const colExpr = (r) => `${Q(instOf(r.inst).alias)}.${Q(r.col)}`;
  const aggExpr = (r) => (r.agg === 'COUNT DISTINCT' ? `COUNT(DISTINCT ${colExpr(r)})` : r.agg ? `${r.agg}(${colExpr(r)})` : colExpr(r));
  function condition(expr, f) {
    const t = f.trim();
    if (!t) return null;
    if (/^(=|<>|!=|<=|>=|<|>|LIKE\b|NOT\b|IN\b|IS\b|BETWEEN\b|ILIKE\b)/i.test(t)) return `${expr} ${t}`;
    if (/^-?\d+(\.\d+)?$/.test(t)) return `${expr} = ${t}`;
    if (/[%_]/.test(t)) return `${expr} LIKE '${t.replaceAll("'", "''")}'`;
    if (/^'.*'$/.test(t)) return `${expr} = ${t}`;
    return `${expr} = '${t.replaceAll("'", "''")}'`;
  }
  function buildSQL() {
    if (!st.inst.length) return { sql: '', warn: [] };
    const warn = [];
    const fromItem = (i) => (i.alias === i.table ? Q(i.table) : `${Q(i.table)} AS ${Q(i.alias)}`);
    const placed = new Set([st.inst[0].id]);
    const parts = [`FROM ${fromItem(st.inst[0])}`];
    const pending = st.inst.slice(1);
    const used = new Set();
    while (pending.length) {
      let progressed = false;
      for (let k = 0; k < pending.length; k++) {
        const inst = pending[k];
        const links = st.joins.filter((j) => !used.has(j) && ((j.a.inst === inst.id && placed.has(j.b.inst)) || (j.b.inst === inst.id && placed.has(j.a.inst))));
        if (!links.length) continue;
        const typ = links[0].type;
        const on = links.map((j) => `${Q(instOf(j.a.inst).alias)}.${Q(j.a.col)} = ${Q(instOf(j.b.inst).alias)}.${Q(j.b.col)}`).join(' AND ');
        // join type is defined from the "a" side; flip LEFT/RIGHT when the new table is on the "a" side
        let jt = typ;
        if (links[0].a.inst === inst.id && typ !== 'INNER') jt = typ === 'LEFT' ? 'RIGHT' : 'LEFT';
        parts.push(`${jt} JOIN ${fromItem(inst)} ON ${on}`);
        links.forEach((j) => used.add(j));
        placed.add(inst.id);
        pending.splice(k, 1);
        progressed = true;
        break;
      }
      if (!progressed) {
        const inst = pending.shift();
        parts.push(`CROSS JOIN ${fromItem(inst)}`);
        placed.add(inst.id);
        warn.push(t('Table {name} is not joined — the result is a CROSS JOIN (every combination of rows).', { name: inst.alias }));
      }
    }
    // joins between already-placed tables that were not used become extra conditions
    const extra = st.joins.filter((j) => !used.has(j) && placed.has(j.a.inst) && placed.has(j.b.inst)).map((j) => `${Q(instOf(j.a.inst).alias)}.${Q(j.a.col)} = ${Q(instOf(j.b.inst).alias)}.${Q(j.b.col)}`);
    const out = st.rows.filter((r) => r.output);
    const sel = out.length ? out.map((r) => aggExpr(r) + (r.alias ? ` AS ${Q(r.alias)}` : '')).join(', ') : '*';
    const where = [...extra, ...st.rows.filter((r) => !r.agg).map((r) => condition(colExpr(r), r.filter)).filter(Boolean)];
    const having = st.rows.filter((r) => r.agg).map((r) => condition(aggExpr(r), r.filter)).filter(Boolean);
    const hasAgg = st.rows.some((r) => r.agg && r.output);
    const group = hasAgg ? out.filter((r) => !r.agg).map(colExpr) : [];
    const order = st.rows.filter((r) => r.sort).map((r) => `${r.output && r.alias ? Q(r.alias) : aggExpr(r)} ${r.sort}`);
    let sql = `SELECT ${st.distinct ? 'DISTINCT ' : ''}${sel} ${parts.join(' ')}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (group.length) sql += ` GROUP BY ${group.join(', ')}`;
    if (having.length) sql += ` HAVING ${having.join(' AND ')}`;
    if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
    if (st.limit) sql += ` LIMIT ${st.limit}`;
    return { sql: formatSQL(sql + ';'), warn };
  }

  // ---------------------------------------------------------------- criteria grid
  function renderCriteria() {
    gridBox.innerHTML = '';
    if (!st.rows.length) {
      gridBox.append(h('div', { class: 'empty', html: `${icon('mouse-pointer-click')}<div>${t('Tick columns on the canvas tables to add them to the query.')}</div>` }));
      return;
    }
    const table = h('table', { class: 'qb-grid' });
    table.append(h('thead', {}, h('tr', {}, ...['', t('Output'), t('Column'), 'Alias', t('Aggregate'), t('Sort'), t('Filter / criteria'), ''].map((x) => h('th', { text: x })))));
    const body = h('tbody');
    st.rows.forEach((r, i) => {
      const inst = instOf(r.inst);
      const out = h('input', { type: 'checkbox' });
      out.checked = r.output;
      out.onchange = () => ((r.output = out.checked), update(false));
      const alias = h('input', { class: 'input sm', value: r.alias, placeholder: '—' });
      alias.oninput = () => ((r.alias = alias.value.trim()), update(false));
      const agg = select(AGGS.map((x) => ({ value: x, label: x || '—' })), r.agg, { class: 'select sm' });
      agg.onchange = () => ((r.agg = agg.value), update(false));
      const sort = select([{ value: '', label: '—' }, { value: 'ASC', label: t('Ascending ↑') }, { value: 'DESC', label: t('Descending ↓') }], r.sort, { class: 'select sm' });
      sort.onchange = () => ((r.sort = sort.value), update(false));
      const filt = h('input', { class: 'input sm mono', value: r.filter, placeholder: t("e.g. > 100, active, LIKE '%a%', IS NULL") });
      filt.oninput = () => ((r.filter = filt.value), update(false));
      const up = h('button', { class: 'btn ghost xs icon', title: t('Move up'), html: icon('chevron-up'), disabled: i === 0, onclick: () => (([st.rows[i - 1], st.rows[i]] = [st.rows[i], st.rows[i - 1]]), update()) });
      const del = h('button', { class: 'btn ghost xs icon danger', title: t('Remove'), html: icon('x'), onclick: () => ((st.rows = st.rows.filter((x) => x !== r)), renderCanvas(), update()) });
      body.append(h('tr', { style: { '--i': i } }, h('td', {}, up), h('td', { class: 'c' }, out), h('td', { class: 'mono', html: `<span class="faint">${esc(inst.alias)}.</span>${esc(r.col)}` }), h('td', {}, alias), h('td', {}, agg), h('td', {}, sort), h('td', { class: 'grow' }, filt), h('td', {}, del)));
    });
    table.append(body);
    gridBox.append(table);
  }

  let warnEl = null;
  function update(reRenderGrid = true) {
    if (reRenderGrid) renderCriteria();
    const { sql, warn } = buildSQL();
    sqlCm.setValue(sql || '-- ' + t('Add tables to the canvas to start building a query'));
    warnEl?.remove();
    warnEl = warn.length ? h('div', { class: 'notice warn qb-warn', html: `${icon('triangle-alert')}<div>${warn.map(esc).join('<br>')}</div>` }) : null;
    if (warnEl) bottomBody.prepend(warnEl);
    runBtn.disabled = toQuery.disabled = !sql;
    tab.sql = sql;
  }

  runBtn.onclick = async () => {
    runBtn.classList.add('loading');
    try {
      const r = await api('POST', `/api/c/${a.conn.id}/query`, { sql: tab.sql, ns: a.ns });
      setView('result');
      resBox.innerHTML = '';
      if (!r.columns.length) resBox.append(h('div', { class: 'empty', text: t('The query returned no rows.') }));
      else renderGrid(resBox, { columns: r.columns, rows: r.rows, animate: true });
      toast(`${plural(r.rows.length, '{n} row', '{n} rows')} · ${r.ms} ms`, 'ok', { timeout: 1600 });
    } catch (e) {
      setView('result');
      resBox.innerHTML = '';
      resBox.append(h('div', { class: 'result-error', text: e.message }));
    } finally {
      runBtn.classList.remove('loading');
    }
  };
  toQuery.onclick = () => app.newQueryTab(tab.sql, false, t('From Query Builder'));
  clearBtn.onclick = () => {
    st.inst = [];
    st.joins = [];
    st.rows = [];
    renderCanvas();
    renderList();
    update();
  };

  renderList();
  renderCanvas();
  update();
  void $;
}

Object.assign(app, { openQueryBuilder });
