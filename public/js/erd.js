// Interactive ERD: draggable tables, animated relation lines, drag column→column to create a foreign key.
import { h, icon, esc, api, qs, state, app, local, toast, showMenu, modal, select, field, sqlPreview, clamp, downloadText, fmtNum, TYPE_LABEL } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { schemaOf, invalidateSchema } from './table.js';
import { motionOK } from './fx.js';

const W = 240;
const HEAD = 38;
const ROW = 22;
const RULES = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

export async function openErd({ focus } = {}) {
  const a = state.active;
  if (!a) return toast('Hubungkan ke database dulu', 'err');
  const existing = findTab((t) => t.kind === 'erd' && t.connId === a.conn.id && t.ns === a.ns);
  if (existing) {
    activateTab(existing.id);
    if (focus) existing.focusTable(focus);
    return;
  }
  const key = `dbs-erd:${a.conn.id}:${a.ns}`;
  const saved = local.get(key, {});
  const st = { models: [], pos: new Map(Object.entries(saved.pos || {})), view: saved.view || { x: 40, y: 40, z: 1 }, keysOnly: Boolean(saved.keysOnly) };

  const panel = h('div');
  const viewport = h('div', { class: 'erd-viewport' });
  const world = h('div', { class: 'erd-world' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('erd-links');
  world.append(svg);
  viewport.append(world);
  const search = h('input', { class: 'input sm', placeholder: 'Cari tabel…', style: { width: '170px' } });
  const zoomLabel = h('span', { class: 'erd-zoom' });
  const B = (ico, tip, fn, label) => h('button', { class: 'btn sm' + (label ? '' : ' icon'), title: tip, html: icon(ico) + (label ? `<span>${label}</span>` : ''), onclick: fn });
  const keysBtn = B('key-round', 'Tampilkan kolom kunci saja', () => {
    st.keysOnly = !st.keysOnly;
    keysBtn.classList.toggle('primary', st.keysOnly);
    render(false);
    persist();
  });
  keysBtn.classList.toggle('primary', st.keysOnly);
  const hudTL = h(
    'div',
    { class: 'erd-hud tl glass' },
    h('div', { class: 'search', html: icon('search') }, search),
    B('layout-dashboard', 'Tata letak otomatis', () => autoLayout(true), 'Rapikan'),
    keysBtn,
    B('scan', 'Muat semua di layar', () => fit(true)),
    B('refresh-cw', 'Muat ulang skema', () => load(true)),
    B('download', 'Export', (e) =>
      showMenu(e, [
        { label: 'Export SVG', icon: 'file-image', action: () => exportImage('svg') },
        { label: 'Export PNG', icon: 'image', action: () => exportImage('png') },
      ]),
    ),
    B('plus', 'Tabel baru', () => app.openDesigner(null)),
  );
  const hudBR = h('div', { class: 'erd-hud br glass' }, B('minus', 'Perkecil', () => zoomBy(1 / 1.2)), zoomLabel, B('plus', 'Perbesar', () => zoomBy(1.2)));
  const minimap = h('div', { class: 'erd-minimap glass' });
  viewport.append(hudTL, hudBR, minimap);
  panel.append(viewport);

  const tab = {
    kind: 'erd',
    icon: 'workflow',
    title: `ERD: ${a.conn.type === 'sqlite' ? a.conn.name : a.ns}`,
    connId: a.conn.id,
    connType: a.conn.type,
    ns: a.ns,
    panel,
    onActivate: () => requestAnimationFrame(() => (drawLinks(false), drawMinimap())),
  };
  tab.focusTable = (name) => focusTable(name);
  addTab(tab);

  const cards = new Map();
  const persist = () => local.set(key, { pos: Object.fromEntries(st.pos), view: st.view, keysOnly: st.keysOnly });

  // ---------------------------------------------------------------- data
  async function load(fresh = false) {
    viewport.classList.add('loading');
    try {
      if (fresh) invalidateSchema();
      st.models = (await schemaOf(a.conn.id, a.ns, { fresh })).filter((m) => m.kind === 'table');
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    viewport.classList.remove('loading');
    // Positions must exist before cards and links are drawn.
    if (st.models.some((m) => !st.pos.has(m.name))) autoLayout(false, { onlyMissing: st.pos.size > 0 });
    render(true);
    if (!saved.view || fresh) fit(false);
    applyView();
    if (focus) setTimeout(() => focusTable(focus), 700);
    if (!st.models.length) {
      viewport.append(h('div', { class: 'empty', style: { position: 'absolute', inset: 0 }, html: `${icon('workflow')}<div>Belum ada tabel di sini.</div>` }));
    }
  }

  const visibleCols = (m) => {
    const fkCols = new Set(m.foreignKeys.flatMap((f) => f.columns));
    return st.keysOnly ? m.columns.filter((c) => m.primaryKey.includes(c.name) || fkCols.has(c.name)) : m.columns;
  };
  const heightOf = (m) => HEAD + visibleCols(m).length * ROW + 8;

  // ---------------------------------------------------------------- render
  function render(animate) {
    for (const c of cards.values()) c.remove();
    cards.clear();
    const anim = animate && motionOK();
    st.models.forEach((m, i) => {
      const fkCols = new Set(m.foreignKeys.flatMap((f) => f.columns));
      const el = h(
        'div',
        { class: 'erd-table' + (anim ? ' pop' : ''), 'data-t': m.name, style: { '--d': `${Math.min(i, 30) * 40}ms` } },
        h(
          'div',
          { class: 'et-head' },
          h('span', { html: icon('table-2') }),
          h('span', { class: 'et-name', text: m.name, title: m.comment || m.name }),
          m.rowsEstimate != null ? h('span', { class: 'et-rows', text: fmtNum(m.rowsEstimate) }) : null,
        ),
      );
      for (const c of visibleCols(m)) {
        const pk = m.primaryKey.includes(c.name);
        const fk = fkCols.has(c.name);
        el.append(
          h(
            'div',
            { class: `et-col${pk ? ' pk' : ''}${fk ? ' fk' : ''}`, 'data-c': c.name, title: `${c.name} : ${c.type}${c.nullable ? '' : ' NOT NULL'}` },
            h('span', { class: 'k', html: pk ? icon('key-round') : fk ? icon('link-2') : icon('dot') }),
            h('span', { class: 'cn', text: c.name }),
            h('span', { class: 'ct', text: String(c.type).replace(/character varying/i, 'varchar') }),
            h('span', { class: 'port l' }),
            h('span', { class: 'port r' }),
          ),
        );
      }
      el.append(h('div', { class: 'et-foot' }));
      const p = st.pos.get(m.name) || { x: 0, y: 0 };
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      wireCard(el, m);
      world.append(el);
      cards.set(m.name, el);
    });
    drawLinks(anim);
    drawMinimap();
  }

  function colY(name, col) {
    const card = cards.get(name);
    const p = st.pos.get(name) || { x: 0, y: 0 };
    const row = card?.querySelector(`.et-col[data-c="${CSS.escape(col)}"]`);
    const y = row ? row.offsetTop + ROW / 2 : HEAD / 2;
    return p.y + y;
  }

  const links = () =>
    st.models.flatMap((m) =>
      m.foreignKeys
        .filter((f) => cards.has(f.refTable))
        .map((f) => ({ fk: f, from: m.name, to: f.refTable, fromCol: f.columns[0], toCol: f.refColumns[0] })),
    );

  function geometry(l) {
    const A = st.pos.get(l.from) || { x: 0, y: 0 };
    const B = st.pos.get(l.to) || { x: 0, y: 0 };
    const y1 = colY(l.from, l.fromCol);
    const y2 = colY(l.to, l.toCol);
    if (l.from === l.to) {
      const x = A.x + W;
      return `M ${x} ${y1} C ${x + 70} ${y1}, ${x + 70} ${y2}, ${x} ${y2}`;
    }
    const aC = A.x + W / 2;
    const bC = B.x + W / 2;
    let x1;
    let x2;
    let d1;
    let d2;
    if (Math.abs(aC - bC) < W * 0.9) {
      x1 = A.x + W;
      x2 = B.x + W;
      const bulge = 60 + Math.abs(y2 - y1) * 0.15;
      d1 = bulge;
      d2 = bulge;
    } else if (aC < bC) {
      x1 = A.x + W;
      x2 = B.x;
      const dx = Math.max(50, (x2 - x1) / 2);
      d1 = dx;
      d2 = -dx;
    } else {
      x1 = A.x;
      x2 = B.x + W;
      const dx = Math.max(50, (x1 - x2) / 2);
      d1 = -dx;
      d2 = dx;
    }
    return `M ${x1} ${y1} C ${x1 + d1} ${y1}, ${x2 + d2} ${y2}, ${x2} ${y2}`;
  }

  function drawLinks(animate) {
    const ls = links();
    let minX = 0;
    let minY = 0;
    let maxX = 1000;
    let maxY = 1000;
    for (const m of st.models) {
      const p = st.pos.get(m.name);
      if (!p) continue;
      minX = Math.min(minX, p.x - 200);
      minY = Math.min(minY, p.y - 200);
      maxX = Math.max(maxX, p.x + W + 200);
      maxY = Math.max(maxY, p.y + heightOf(m) + 200);
    }
    svg.setAttribute('width', maxX - minX);
    svg.setAttribute('height', maxY - minY);
    svg.style.left = minX + 'px';
    svg.style.top = minY + 'px';
    svg.innerHTML = `<defs>
      <linearGradient id="erd-grad" gradientUnits="userSpaceOnUse" x1="${minX}" y1="0" x2="${maxX}" y2="0"><stop offset="0" stop-color="#8b5cff"/><stop offset=".5" stop-color="#36d6ff"/><stop offset="1" stop-color="#2dffb3"/></linearGradient>
      <marker id="erd-many" viewBox="0 0 12 12" refX="1" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M12 6 L1 1 M12 6 L1 6 M12 6 L1 11" stroke="#2dffb3" stroke-width="1.4" fill="none"/></marker>
      <marker id="erd-one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M6 1 L6 11 M9 1 L9 11" stroke="#8b5cff" stroke-width="1.6" fill="none"/></marker>
    </defs><g transform="translate(${-minX} ${-minY})"></g>`;
    const g = svg.querySelector('g');
    ls.forEach((l, i) => {
      const d = geometry(l);
      const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      grp.dataset.from = l.from;
      grp.dataset.to = l.to;
      grp.innerHTML = `<path class="hit" d="${d}" stroke="transparent" stroke-width="14" fill="none" style="pointer-events:stroke;cursor:pointer"/><path class="link" d="${d}" marker-start="url(#erd-many)" marker-end="url(#erd-one)"/><path class="flow" d="${d}"/>`;
      g.append(grp);
      const path = grp.querySelector('.link');
      if (animate) {
        const len = path.getTotalLength();
        path.style.setProperty('--len', len);
        path.style.setProperty('--d', `${0.25 + Math.min(i, 30) * 0.05}s`);
        path.classList.add('draw');
        path.addEventListener('animationend', () => path.classList.remove('draw'), { once: true });
      }
      const hit = grp.querySelector('.hit');
      hit.addEventListener('mouseenter', () => highlight([l.from, l.to], grp));
      hit.addEventListener('mouseleave', () => highlight(null));
      hit.addEventListener('click', (e) => linkMenu(e, l));
    });
  }

  function reroute(names) {
    const set = new Set(names);
    svg.querySelectorAll('g[data-from]').forEach((grp) => {
      if (!set.has(grp.dataset.from) && !set.has(grp.dataset.to)) return;
      const l = links().find((x) => x.from === grp.dataset.from && x.to === grp.dataset.to);
      if (!l) return;
      const d = geometry(l);
      grp.querySelectorAll('path').forEach((p) => p.setAttribute('d', d));
    });
  }

  function highlight(names, grp) {
    if (!names) {
      viewport.classList.remove('erd-dim');
      viewport.querySelectorAll('.hot').forEach((e) => e.classList.remove('hot'));
      return;
    }
    viewport.classList.add('erd-dim');
    const set = new Set(names);
    for (const [n, el] of cards) el.classList.toggle('hot', set.has(n));
    svg.querySelectorAll('g[data-from]').forEach((g) => {
      const on = grp ? g === grp : set.has(g.dataset.from) || set.has(g.dataset.to);
      g.querySelectorAll('.link, .flow').forEach((p) => p.classList.toggle('hot', on));
      if (on) {
        cards.get(g.dataset.from)?.classList.add('hot');
        cards.get(g.dataset.to)?.classList.add('hot');
      }
    });
  }

  // ---------------------------------------------------------------- interactions
  function wireCard(el, m) {
    const head = el.querySelector('.et-head');
    el.addEventListener('mouseenter', () => !linking && highlight([m.name]));
    el.addEventListener('mouseleave', () => !linking && highlight(null));
    head.addEventListener('dblclick', () => app.openTableTab(m.name));
    head.addEventListener('contextmenu', (e) =>
      showMenu(e, [
        { label: m.name, header: true },
        { label: 'Buka data', icon: 'table', action: () => app.openTableTab(m.name) },
        { label: 'Desain tabel…', icon: 'pencil-ruler', action: () => app.openDesigner(m.name) },
        { label: 'Relasi & index', icon: 'git-fork', action: () => app.openTableTab(m.name, 'relations') },
      ]),
    );
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      head.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY };
      const p0 = { ...st.pos.get(m.name) };
      let raf = 0;
      el.style.zIndex = 10;
      const move = (ev) => {
        const p = { x: Math.round(p0.x + (ev.clientX - start.x) / st.view.z), y: Math.round(p0.y + (ev.clientY - start.y) / st.view.z) };
        st.pos.set(m.name, p);
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            reroute([m.name]);
          });
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        el.style.zIndex = '';
        drawLinks(false);
        drawMinimap();
        persist();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    el.querySelectorAll('.port').forEach((port) => port.addEventListener('pointerdown', (e) => startLink(e, m.name, port.closest('.et-col').dataset.c, port)));
  }

  // drag a column port onto another column to create a foreign key (child → parent)
  let linking = null;
  function startLink(e, table, col, port) {
    e.stopPropagation();
    e.preventDefault();
    const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    temp.classList.add('temp');
    svg.querySelector('g').append(temp);
    const off = { x: parseFloat(svg.style.left), y: parseFloat(svg.style.top) };
    const p = st.pos.get(table);
    const x1 = p.x + (port.classList.contains('r') ? W : 0);
    const y1 = colY(table, col);
    linking = { table, col };
    viewport.classList.add('erd-linking');
    let target = null;
    const toWorld = (ev) => {
      const r = viewport.getBoundingClientRect();
      return { x: (ev.clientX - r.left - st.view.x) / st.view.z, y: (ev.clientY - r.top - st.view.y) / st.view.z };
    };
    const move = (ev) => {
      const w = toWorld(ev);
      temp.setAttribute('d', `M ${x1} ${y1} C ${x1 + (w.x > x1 ? 60 : -60)} ${y1}, ${w.x + (w.x > x1 ? -60 : 60)} ${w.y}, ${w.x} ${w.y}`);
      void off;
      const elUnder = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.et-col');
      if (target && target !== elUnder) target.classList.remove('drop-target');
      target = elUnder && elUnder.closest('.erd-table')?.dataset.t !== table ? elUnder : null;
      target?.classList.add('drop-target');
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      temp.remove();
      viewport.classList.remove('erd-linking');
      linking = null;
      if (target) {
        target.classList.remove('drop-target');
        createRelation(table, col, target.closest('.erd-table').dataset.t, target.dataset.c);
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  async function changeFks(table, mutate, title) {
    const model = await api('GET', `/api/c/${a.conn.id}/describe${qs({ ns: a.ns, table })}`);
    const next = { ...model, columns: model.columns.map((c) => ({ ...c, origName: c.name })), indexes: model.indexes.filter((i) => !i.complex) };
    mutate(next);
    const r = await api('POST', `/api/c/${a.conn.id}/sql/alter-table`, { ns: a.ns, table, model: next });
    const ok = await sqlPreview({ title, sub: `${TYPE_LABEL[a.conn.type]} · ${table}`, statements: r.statements, warnings: r.warnings, connId: a.conn.id, ns: a.ns, type: a.conn.type, confirmLabel: 'Terapkan' });
    if (ok) {
      toast(title, 'ok', { title: 'Relasi diperbarui' });
      await load(true);
    }
  }

  function createRelation(child, childCol, parent, parentCol) {
    const name = h('input', { class: 'input mono', value: `fk_${child}_${parent}`.slice(0, 60) });
    const onDel = select(RULES, 'NO ACTION');
    const onUpd = select(RULES, 'NO ACTION');
    const flow = h('div', { class: 'row', style: { justifyContent: 'center', gap: '14px', padding: '6px 0' }, html: `<span class="chip info">${esc(child)}.${esc(childCol)}</span>${icon('arrow-right')}<span class="chip ok">${esc(parent)}.${esc(parentCol)}</span>` });
    modal({
      title: 'Buat relasi',
      sub: 'Kolom anak (foreign key) → kolom induk yang dirujuk',
      icon: 'git-fork',
      body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, flow, field('Nama constraint', name), h('div', { class: 'form-grid' }, field('ON DELETE', onDel), field('ON UPDATE', onUpd))),
      actions: [
        'spacer',
        { label: 'Batal' },
        {
          label: 'Lanjut',
          kind: 'primary',
          icon: 'arrow-right',
          onClick: () => {
            setTimeout(() =>
              changeFks(
                child,
                (m) => m.foreignKeys.push({ name: name.value.trim(), columns: [childCol], refTable: parent, refColumns: [parentCol], onDelete: onDel.value, onUpdate: onUpd.value }),
                `Relasi ${child}.${childCol} → ${parent}.${parentCol}`,
              ).catch((e) => toast(e.message, 'err')),
            );
            return true;
          },
        },
      ],
    });
  }

  function linkMenu(e, l) {
    const f = l.fk;
    showMenu(e, [
      { label: `${l.from}(${f.columns.join(', ')}) → ${l.to}(${f.refColumns.join(', ')})`, header: true },
      { label: `ON DELETE ${f.onDelete || 'NO ACTION'} · ON UPDATE ${f.onUpdate || 'NO ACTION'}`, header: true },
      { label: `Buka ${l.from}`, icon: 'table', action: () => app.openTableTab(l.from) },
      { label: `Buka ${l.to}`, icon: 'table', action: () => app.openTableTab(l.to) },
      '-',
      {
        label: 'Hapus relasi…',
        icon: 'unlink',
        danger: true,
        action: () =>
          changeFks(l.from, (m) => (m.foreignKeys = m.foreignKeys.filter((x) => !(x.columns.join() === f.columns.join() && x.refTable === f.refTable))), `Hapus relasi ${f.name}`).catch((err) => toast(err.message, 'err')),
      },
    ]);
  }

  // pan & zoom
  function applyView() {
    world.style.transform = `translate(${st.view.x}px, ${st.view.y}px) scale(${st.view.z})`;
    zoomLabel.textContent = Math.round(st.view.z * 100) + '%';
    drawMinimap();
  }
  function zoomAt(factor, cx, cy) {
    const z = clamp(st.view.z * factor, 0.2, 2.2);
    const k = z / st.view.z;
    st.view.x = cx - (cx - st.view.x) * k;
    st.view.y = cy - (cy - st.view.y) * k;
    st.view.z = z;
    applyView();
    persistSoon();
  }
  const zoomBy = (f) => zoomAt(f, viewport.clientWidth / 2, viewport.clientHeight / 2);
  let persistT;
  const persistSoon = () => {
    clearTimeout(persistT);
    persistT = setTimeout(persist, 300);
  };
  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      else {
        st.view.x -= e.deltaX;
        st.view.y -= e.deltaY;
        applyView();
        persistSoon();
      }
    },
    { passive: false },
  );
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.erd-table, .erd-hud, .erd-minimap, path.hit') || e.button !== 0) return;
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add('panning');
    const s = { x: e.clientX - st.view.x, y: e.clientY - st.view.y };
    const move = (ev) => {
      st.view.x = ev.clientX - s.x;
      st.view.y = ev.clientY - s.y;
      applyView();
    };
    const up = () => {
      viewport.classList.remove('panning');
      viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up);
      persist();
    };
    viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up);
  });

  function bbox() {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const m of st.models) {
      const p = st.pos.get(m.name);
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + W);
      y1 = Math.max(y1, p.y + heightOf(m));
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 800, y1: 600 };
  }
  function fit(animate) {
    const b = bbox();
    const vw = viewport.clientWidth || 1000;
    const vh = viewport.clientHeight || 700;
    const z = clamp(Math.min((vw - 120) / (b.x1 - b.x0), (vh - 140) / (b.y1 - b.y0)), 0.2, 1.2);
    const target = { z, x: (vw - (b.x1 - b.x0) * z) / 2 - b.x0 * z, y: (vh - (b.y1 - b.y0) * z) / 2 - b.y0 * z + 20 };
    animateView(target, animate);
  }
  function animateView(target, animate) {
    if (!animate || !motionOK()) {
      st.view = target;
      applyView();
      persist();
      return;
    }
    const from = { ...st.view };
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 650);
      const e = 1 - Math.pow(1 - k, 4);
      st.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e };
      applyView();
      if (k < 1) requestAnimationFrame(step);
      else persist();
    };
    requestAnimationFrame(step);
  }
  function focusTable(name) {
    const p = st.pos.get(name);
    const el = cards.get(name);
    if (!p || !el) return toast(`Tabel ${name} tidak ada di ERD`, 'err');
    const z = Math.max(st.view.z, 0.9);
    animateView({ z, x: viewport.clientWidth / 2 - (p.x + W / 2) * z, y: viewport.clientHeight / 2 - (p.y + 80) * z }, true);
    el.classList.remove('found');
    void el.offsetWidth;
    el.classList.add('found');
  }
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = search.value.trim().toLowerCase();
    const hit = st.models.find((m) => m.name.toLowerCase() === q) || st.models.find((m) => m.name.toLowerCase().includes(q));
    if (hit) focusTable(hit.name);
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const [n, el] of cards) el.style.opacity = !q || n.toLowerCase().includes(q) ? '' : 0.25;
  });

  // ---------------------------------------------------------------- layout
  function autoLayout(animate, { onlyMissing = false } = {}) {
    const names = st.models.map((m) => m.name);
    const set = new Set(names);
    const refs = new Map(st.models.map((m) => [m.name, [...new Set(m.foreignKeys.map((f) => f.refTable).filter((r) => set.has(r) && r !== m.name))]]));
    const level = new Map();
    const visiting = new Set();
    const lv = (n) => {
      if (level.has(n)) return level.get(n);
      if (visiting.has(n)) return 0;
      visiting.add(n);
      const r = refs.get(n);
      const l = r.length ? 1 + Math.max(...r.map(lv)) : 0;
      visiting.delete(n);
      level.set(n, l);
      return l;
    };
    names.forEach(lv);
    const referenced = new Set([...refs.values()].flat());
    const isolated = names.filter((n) => !refs.get(n).length && !referenced.has(n));
    const groups = new Map();
    for (const n of names) {
      if (isolated.includes(n)) continue;
      const l = level.get(n);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(n);
    }
    const order = new Map();
    const levels = [...groups.keys()].sort((x, y) => x - y);
    const bary = (n) => {
      const r = refs.get(n).filter((x) => order.has(x));
      return r.length ? r.reduce((s, x) => s + order.get(x), 0) / r.length : 0;
    };
    const model = (n) => st.models.find((m) => m.name === n);
    const next = new Map();
    const GAP_X = 130;
    const GAP_Y = 46;
    for (const l of levels) {
      const g = groups.get(l).sort((x, y) => bary(x) - bary(y) || x.localeCompare(y));
      let y = 0;
      g.forEach((n, i) => {
        order.set(n, i);
        next.set(n, { x: l * (W + GAP_X), y });
        y += heightOf(model(n)) + GAP_Y;
      });
    }
    const startX = (levels.length ? Math.max(...levels) + 1 : 0) * (W + GAP_X);
    const perCol = Math.max(1, Math.ceil(Math.sqrt(isolated.length)));
    const colY = new Array(perCol).fill(0);
    isolated.sort().forEach((n, i) => {
      const c = i % perCol;
      next.set(n, { x: startX + c * (W + 50), y: colY[c] });
      colY[c] += heightOf(model(n)) + 34;
    });
    for (const [n, p] of next) if (!onlyMissing || !st.pos.has(n)) st.pos.set(n, p);
    if (animate && motionOK()) {
      world.classList.add('animate');
      for (const [n, el] of cards) {
        el.style.left = st.pos.get(n).x + 'px';
        el.style.top = st.pos.get(n).y + 'px';
      }
      const t0 = performance.now();
      const target = new Map(st.pos);
      const tick = (t) => {
        // let the links follow the cards while their CSS transition runs
        for (const [n, el] of cards) st.pos.set(n, { x: el.offsetLeft, y: el.offsetTop });
        reroute(names);
        for (const [n, p] of target) st.pos.set(n, p);
        if (t - t0 < 800) requestAnimationFrame(tick);
        else {
          world.classList.remove('animate');
          drawLinks(false);
          drawMinimap();
          fit(true);
        }
      };
      requestAnimationFrame(tick);
    } else {
      for (const [n, el] of cards) {
        el.style.left = st.pos.get(n).x + 'px';
        el.style.top = st.pos.get(n).y + 'px';
      }
      drawLinks(false);
      drawMinimap();
    }
    persist();
  }

  // ---------------------------------------------------------------- minimap
  function drawMinimap() {
    if (!st.models.length || !viewport.clientWidth) return (minimap.hidden = true);
    minimap.hidden = false;
    const b = bbox();
    const pad = 40;
    const bw = b.x1 - b.x0 + pad * 2;
    const bh = b.y1 - b.y0 + pad * 2;
    const k = Math.min(180 / bw, 120 / bh);
    minimap.innerHTML = '';
    for (const m of st.models) {
      const p = st.pos.get(m.name);
      if (!p) continue;
      minimap.append(h('div', { class: 'mm-t', style: { left: (p.x - b.x0 + pad) * k + 'px', top: (p.y - b.y0 + pad) * k + 'px', width: W * k + 'px', height: heightOf(m) * k + 'px' } }));
    }
    const vx = -st.view.x / st.view.z;
    const vy = -st.view.y / st.view.z;
    minimap.append(h('div', { class: 'mm-view', style: { left: (vx - b.x0 + pad) * k + 'px', top: (vy - b.y0 + pad) * k + 'px', width: (viewport.clientWidth / st.view.z) * k + 'px', height: (viewport.clientHeight / st.view.z) * k + 'px' } }));
    minimap.onpointerdown = (e) => {
      const r = minimap.getBoundingClientRect();
      const go = (ev) => {
        const wx = (ev.clientX - r.left) / k + b.x0 - pad;
        const wy = (ev.clientY - r.top) / k + b.y0 - pad;
        st.view.x = viewport.clientWidth / 2 - wx * st.view.z;
        st.view.y = viewport.clientHeight / 2 - wy * st.view.z;
        applyView();
      };
      go(e);
      minimap.setPointerCapture(e.pointerId);
      minimap.onpointermove = go;
      minimap.onpointerup = () => {
        minimap.onpointermove = null;
        persist();
      };
    };
  }

  // ---------------------------------------------------------------- export
  function exportImage(kind) {
    const b = bbox();
    const pad = 40;
    const w = b.x1 - b.x0 + pad * 2;
    const hgt = b.y1 - b.y0 + pad * 2;
    const ox = -b.x0 + pad;
    const oy = -b.y0 + pad;
    const dark = document.documentElement.dataset.theme !== 'light' && !(matchMedia('(prefers-color-scheme: light)').matches && !document.documentElement.dataset.theme);
    const C = dark ? { bg: '#0a0c15', card: '#141829', head: '#1c2140', line: '#2a3050', text: '#e9ebf8', mute: '#7a80a6' } : { bg: '#f4f5fb', card: '#ffffff', head: '#ecebff', line: '#d6d9ea', text: '#12162e', mute: '#7a809e' };
    const x = (s) => esc(s);
    let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" font-family="JetBrains Mono, monospace">`;
    out += `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#8b5cff"/><stop offset=".5" stop-color="#36d6ff"/><stop offset="1" stop-color="#2dffb3"/></linearGradient></defs><rect width="100%" height="100%" fill="${C.bg}"/>`;
    for (const l of links()) {
      const A = st.pos.get(l.from);
      void A;
      out += `<path d="${geometry(l)}" transform="translate(${ox} ${oy})" fill="none" stroke="#36d6ff" stroke-width="1.6" opacity=".85"/>`;
    }
    for (const m of st.models) {
      const p = st.pos.get(m.name);
      const cx = p.x + ox;
      const cy = p.y + oy;
      const hh = heightOf(m);
      out += `<g><rect x="${cx}" y="${cy}" width="${W}" height="${hh}" rx="12" fill="${C.card}" stroke="${C.line}"/><path d="M${cx} ${cy + 12} a12 12 0 0 1 12 -12 h${W - 24} a12 12 0 0 1 12 12 v${HEAD - 12} h-${W} z" fill="${C.head}"/>`;
      out += `<text x="${cx + 14}" y="${cy + 24}" font-family="Space Grotesk, sans-serif" font-weight="600" font-size="13" fill="${C.text}">${x(m.name)}</text>`;
      const fkCols = new Set(m.foreignKeys.flatMap((f) => f.columns));
      visibleCols(m).forEach((c, i) => {
        const ry = cy + HEAD + i * ROW + 15;
        const mark = m.primaryKey.includes(c.name) ? '🔑' : fkCols.has(c.name) ? '↗' : '·';
        out += `<text x="${cx + 12}" y="${ry}" font-size="11" fill="${C.mute}">${mark}</text><text x="${cx + 28}" y="${ry}" font-size="11.5" fill="${C.text}">${x(c.name)}</text><text x="${cx + W - 12}" y="${ry}" font-size="10" text-anchor="end" fill="${C.mute}">${x(String(c.type).slice(0, 16))}</text>`;
      });
      out += '</g>';
    }
    out += '</svg>';
    const base = `erd-${(a.conn.type === 'sqlite' ? a.conn.name : a.ns).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '')}`;
    if (kind === 'svg') return downloadText(base + '.svg', out, 'image/svg+xml');
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = h('canvas', { width: w * scale, height: hgt * scale });
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        const link = h('a', { href: URL.createObjectURL(blob), download: base + '.png' });
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      });
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(out);
  }

  await load(false);
}

Object.assign(app, { openErd });
