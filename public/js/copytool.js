// Copy wizard: copy tables (structure/data) to another database, schema, server — or engine.
import { h, icon, esc, api, qs, state, app, toast, watchJob, segmented, toggle, checkbox, fmtNum, TYPE_LABEL, connById, nsLabel, engineBadge } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { namespacesOf, defaultNsFor, connSelect } from './conn.js';
import { countUp } from './fx.js';

export function progressRing(size = 110) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const el = h('div', {
    html: `<svg class="ring" viewBox="0 0 110 110" width="${size}" height="${size}"><defs><linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cff"/><stop offset=".5" stop-color="#36d6ff"/><stop offset="1" stop-color="#2dffb3"/></linearGradient></defs><circle class="bg" cx="55" cy="55" r="${r}"/><circle class="fg" cx="55" cy="55" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c}"/><text x="55" y="55">0%</text></svg>`,
  });
  el.set = (p) => {
    el.querySelector('.fg').setAttribute('stroke-dashoffset', String(c * (1 - p)));
    el.querySelector('text').textContent = Math.round(p * 100) + '%';
  };
  return el;
}

export async function openCopy({ tables: preselect = null, all = false } = {}) {
  if (!state.conns.length) return toast('Belum ada koneksi', 'err');
  const prev = findTab((t) => t.kind === 'copy' && !t.running);
  if (prev && !preselect && !all) return activateTab(prev.id);

  const a = state.active;
  const st = {
    srcId: a?.conn.id || state.conns[0].id,
    srcNs: a?.ns || null,
    dstId: a?.conn.id || state.conns[0].id,
    dstNs: null,
    mode: 'both',
    drop: false,
    fks: true,
    tables: [],
    views: [],
    pick: new Map(), // name -> { on, target }
    pickViews: new Set(),
    dstTables: new Set(),
    filter: '',
  };

  const panel = h('div');
  const srcConnSel = connSelect(st.srcId, (v) => ((st.srcId = v), (st.srcNs = null), loadSrc()));
  const dstConnSel = connSelect(st.dstId, (v) => ((st.dstId = v), (st.dstNs = null), loadDst()));
  const srcNsSel = h('select', { class: 'select' });
  const dstNsSel = h('select', { class: 'select' });
  srcNsSel.onchange = () => ((st.srcNs = srcNsSel.value), loadSrcTables());
  dstNsSel.onchange = () => ((st.dstNs = dstNsSel.value), loadDstTables());
  const filter = h('input', { class: 'input sm', placeholder: 'Saring tabel…' });
  filter.oninput = () => ((st.filter = filter.value.toLowerCase()), renderPick());
  const allBox = checkbox('Pilih semua', false, (v) => {
    for (const [n, p] of st.pick) if (!st.filter || n.toLowerCase().includes(st.filter)) p.on = v;
    renderPick();
  });
  const pickList = h('div', { class: 'table-pick' });
  const viewList = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
  const summary = h('div', { class: 'faint', style: { fontSize: '12px' } });
  const engineNote = h('div', { class: 'notice info', hidden: true });
  const startBtn = h('button', { class: 'btn primary', html: icon('rocket') + '<span>Mulai salin</span>' });

  const srcCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title', html: icon('database') + 'Sumber' }),
    h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { text: 'Koneksi' }), srcConnSel), h('div', { class: 'field' }, h('label', { class: 'src-ns-label', text: 'Database' }), srcNsSel)),
    h('div', { class: 'row', style: { margin: '14px 0 8px' } }, h('div', { class: 'search grow', html: icon('search') }, filter), allBox),
    h('div', { class: 'tp-row', style: { borderBottom: 0, padding: '0 10px 4px', fontSize: '10.5px', color: 'var(--text-3)', fontFamily: 'var(--sans)', fontWeight: 600, letterSpacing: '.6px', textTransform: 'uppercase', display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) 90px minmax(0,1fr)', gap: '10px' }, html: '<span style="width:16px"></span><span>Tabel</span><span style="text-align:right">Baris</span><span>Nama di tujuan</span>' }),
    pickList,
    h('div', { class: 'section-label', style: { margin: '14px 0 8px' }, text: 'View (opsional)' }),
    viewList,
  );
  const modeSeg = segmented(
    [
      { value: 'both', label: 'Struktur + data', icon: 'layers' },
      { value: 'structure', label: 'Struktur', icon: 'table-properties' },
      { value: 'data', label: 'Data saja', icon: 'rows-3' },
    ],
    st.mode,
    (v) => ((st.mode = v), renderSummary()),
  );
  const dstCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title', html: icon('database-backup') + 'Tujuan' }),
    h(
      'div',
      { class: 'form-grid' },
      h('div', { class: 'field' }, h('label', { text: 'Koneksi' }), dstConnSel),
      h('div', { class: 'field' }, h('label', { class: 'dst-ns-label', text: 'Database' }), h('div', { class: 'row' }, dstNsSel, h('button', { class: 'btn icon', title: 'Buat baru', html: icon('folder-plus'), onclick: () => app.createNamespace({ connId: st.dstId, onCreated: (n) => ((st.dstNs = n), loadDst(true)) }) }))),
    ),
    h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', { text: 'Yang disalin' }), modeSeg),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '10px', margin: '14px 0' } },
      toggle('Hapus tabel yang sudah ada di tujuan (DROP)', st.drop, (v) => ((st.drop = v), renderPick(), renderSummary())),
      toggle('Salin relasi (foreign key)', st.fks, (v) => (st.fks = v)),
    ),
    engineNote,
    h('div', { class: 'row', style: { marginTop: '14px' } }, summary, h('span', { class: 'spacer' }), startBtn),
  );

  const ring = progressRing();
  const progTitle = h('div', { style: { font: '600 16px var(--display)' } });
  const progPhase = h('div', { class: 'faint' });
  const progRows = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '16px 0' } });
  const log = h('div', { class: 'log' });
  const progActions = h('div', { class: 'row' });
  const progCard = h('div', { class: 'card', hidden: true, style: { marginTop: '14px' } }, h('div', { class: 'big-progress' }, ring, h('div', { class: 'grow' }, progTitle, progPhase, h('div', { class: 'row', style: { marginTop: '10px' } }, progActions))), progRows, log);

  panel.append(
    h(
      'div',
      { class: 'scroll-pad' },
      h('div', { class: 'row', style: { marginBottom: '14px' } }, h('div', { html: `<div style="font:700 22px var(--display)">Salin tabel</div><div class="faint">Ke database lain, server lain, bahkan engine lain — struktur, data, dan relasinya.</div>` })),
      h('div', { class: 'two-col' }, srcCard, dstCard),
      progCard,
    ),
  );

  const tab = { kind: 'copy', icon: 'copy-plus', title: 'Salin tabel', panel, running: false, isDirty: () => tab.running };
  addTab(tab);

  // ---------------------------------------------------------------- loading
  async function fillNs(sel, connId, current) {
    const conn = connById(connId);
    sel.innerHTML = '';
    if (conn.type === 'sqlite') {
      sel.append(h('option', { value: 'main' }, 'main (file)'));
      sel.disabled = true;
      return 'main';
    }
    sel.disabled = false;
    const list = await namespacesOf(connId);
    const ns = current && list.includes(current) ? current : defaultNsFor(conn, list);
    for (const n of list) sel.append(h('option', { value: n, selected: n === ns }, n));
    return ns;
  }
  async function loadSrc() {
    try {
      st.srcNs = await fillNs(srcNsSel, st.srcId, st.srcNs);
      panel.querySelector('.src-ns-label').textContent = nsLabel(connById(st.srcId).type);
      await loadSrcTables();
    } catch (e) {
      toast(e.message, 'err', { title: 'Sumber' });
    }
  }
  async function loadSrcTables() {
    pickList.innerHTML = '';
    for (let i = 0; i < 6; i++) pickList.append(h('div', { class: 'skeleton', style: { height: '18px', margin: '10px' } }));
    const list = await api('GET', `/api/c/${st.srcId}/tables${qs({ ns: st.srcNs })}`);
    st.tables = list.filter((t) => t.kind === 'table');
    st.views = list.filter((t) => t.kind === 'view');
    st.pick = new Map(st.tables.map((t) => [t.name, { on: all || (preselect ? preselect.includes(t.name) : false), target: t.name, rows: t.approxRows }]));
    st.pickViews = new Set(all ? st.views.map((v) => v.name) : []);
    preselect = null;
    all = false;
    renderPick();
    renderViews();
  }
  async function loadDst(force = false) {
    try {
      if (force) (await import('./conn.js')).forgetNamespaces(st.dstId);
      st.dstNs = await fillNs(dstNsSel, st.dstId, st.dstNs);
      panel.querySelector('.dst-ns-label').textContent = nsLabel(connById(st.dstId).type);
      await loadDstTables();
    } catch (e) {
      toast(e.message, 'err', { title: 'Tujuan' });
    }
  }
  async function loadDstTables() {
    const list = await api('GET', `/api/c/${st.dstId}/tables${qs({ ns: st.dstNs })}`).catch(() => []);
    st.dstTables = new Set(list.map((t) => t.name));
    renderPick();
    renderSummary();
  }

  function renderPick() {
    pickList.innerHTML = '';
    const rows = [...st.pick].filter(([n]) => !st.filter || n.toLowerCase().includes(st.filter));
    if (!rows.length) pickList.append(h('div', { class: 'empty', text: st.tables.length ? 'Tidak ada yang cocok' : 'Tidak ada tabel' }));
    rows.forEach(([name, p], i) => {
      const target = h('input', { class: 'input sm mono', value: p.target });
      target.oninput = () => ((p.target = target.value.trim() || name), renderSummary(), mark());
      const warn = h('span', { class: 'chip warn', style: { marginLeft: '6px' }, html: icon('triangle-alert') + 'ada' });
      const mark = () => (warn.hidden = !(p.on && st.dstTables.has(p.target) && st.mode !== 'data' && !st.drop));
      mark();
      const cb = checkbox('', p.on, (v) => ((p.on = v), mark(), renderSummary()));
      pickList.append(h('div', { class: 'tp-row', style: { '--i': i } }, cb, h('span', { text: name, title: name, style: { overflow: 'hidden', textOverflow: 'ellipsis' } }), h('span', { class: 'tp-rows', text: p.rows != null ? fmtNum(p.rows) : '' }), h('div', { class: 'row' }, target, warn)));
    });
    renderSummary();
  }
  function renderViews() {
    viewList.innerHTML = '';
    if (!st.views.length) viewList.append(h('span', { class: 'faint', text: 'Tidak ada view' }));
    for (const v of st.views) viewList.append(h('div', { class: 'chip', style: { height: '28px' } }, checkbox(v.name, st.pickViews.has(v.name), (on) => (on ? st.pickViews.add(v.name) : st.pickViews.delete(v.name)))));
  }
  function renderSummary() {
    const chosen = [...st.pick.values()].filter((p) => p.on);
    const src = connById(st.srcId);
    const dst = connById(st.dstId);
    const known = chosen.filter((p) => p.rows != null);
    const rows = known.reduce((s, p) => s + (Number(p.rows) || 0), 0);
    summary.innerHTML = `<b>${chosen.length}</b> tabel dipilih${known.length ? ` · ±${fmtNum(rows)} baris` : ''}`;
    startBtn.disabled = !chosen.length || tab.running;
    if (src && dst && src.type !== dst.type) {
      engineNote.hidden = false;
      engineNote.innerHTML = `${icon('shuffle')}<div>${engineBadge(src.type, true)} ${TYPE_LABEL[src.type]} → ${engineBadge(dst.type, true)} ${TYPE_LABEL[dst.type]}: tipe kolom, default, boolean, JSON & BLOB dikonversi otomatis. Index berbasis ekspresi dan trigger tidak ikut.</div>`;
    } else engineNote.hidden = true;
  }

  // ---------------------------------------------------------------- run
  startBtn.onclick = async () => {
    const tables = [...st.pick].filter(([, p]) => p.on).map(([name, p]) => ({ name, targetName: p.target || name }));
    if (!tables.length) return;
    tab.running = true;
    startBtn.disabled = true;
    progCard.hidden = false;
    progCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    progTitle.textContent = `${tables.length} tabel → ${connById(st.dstId).name}${connById(st.dstId).type !== 'sqlite' ? ' / ' + st.dstNs : ''}`;
    progActions.innerHTML = '';
    let jobId;
    const cancel = h('button', { class: 'btn sm', html: icon('square') + '<span>Batalkan</span>', onclick: () => jobId && api('POST', `/api/jobs/${jobId}/cancel`) });
    progActions.append(cancel);
    const bars = new Map();
    try {
      const job = await api('POST', '/api/jobs/copy', { srcId: st.srcId, srcNs: st.srcNs, dstId: st.dstId, dstNs: st.dstNs, tables, views: [...st.pickViews], mode: st.mode, dropExisting: st.drop, foreignKeys: st.fks });
      jobId = job.id;
      const final = await watchJob(job, (j) => {
        ring.set(j.progress);
        progPhase.textContent = j.phase;
        for (const it of j.items) {
          if (!bars.has(it.key)) {
            const bar = h('div', { class: 'progress', html: '<i></i>' });
            const label = h('span', { class: 'faint', style: { fontSize: '11.5px', minWidth: '130px', textAlign: 'right' } });
            const row = h('div', { class: 'row', style: { animation: 'item-in .4s var(--ease) both' } }, h('span', { class: 'mono', style: { width: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }, text: it.target && it.target !== it.key ? `${it.key} → ${it.target}` : it.key }), h('div', { class: 'grow' }, bar), label);
            progRows.append(row);
            bars.set(it.key, { bar, label });
          }
          const b = bars.get(it.key);
          const p = it.rows ? Math.min(1, (it.done || 0) / it.rows) : it.status === 'selesai' ? 1 : 0;
          b.bar.firstChild.style.setProperty('--p', (it.status === 'selesai' ? 100 : p * 100) + '%');
          b.bar.classList.toggle('done', it.status === 'selesai');
          b.label.textContent = it.rows ? `${fmtNum(it.done || 0)} / ${fmtNum(it.rows)}` : it.status || '';
        }
        log.innerHTML = j.log.map((l) => `<div class="${l.level}"><span class="t">${new Date(l.t).toLocaleTimeString('id-ID')}</span>${esc(l.msg)}</div>`).join('');
        log.scrollTop = log.scrollHeight;
      });
      cancel.remove();
      if (final.status === 'done') {
        toast(`${final.result.tables} tabel · ${fmtNum(final.result.rows)} baris`, 'ok', { title: 'Salin selesai' });
        const big = h('b', { class: 'count-up' });
        progPhase.innerHTML = '';
        progPhase.append(h('span', { html: `${icon('circle-check')} Selesai — ` }), big, ' baris disalin');
        countUp(big, final.result.rows);
        progActions.append(
          h('button', {
            class: 'btn sm primary',
            html: icon('arrow-right') + '<span>Buka tujuan</span>',
            onclick: async () => {
              await app.connect(st.dstId);
              if (state.active?.conn.id === st.dstId && state.active.ns !== st.dstNs && connById(st.dstId).type !== 'sqlite') await app.setNamespace(st.dstNs);
            },
          }),
        );
        if (state.active?.conn.id === st.dstId && (state.active.ns === st.dstNs || connById(st.dstId).type === 'sqlite')) app.loadTree();
        loadDstTables();
      } else {
        toast(final.error || 'Dibatalkan', final.status === 'cancelled' ? 'info' : 'err', { title: final.status === 'cancelled' ? 'Dibatalkan' : 'Salin gagal' });
        ring.querySelector('.fg').style.stroke = 'var(--danger)';
      }
    } catch (e) {
      toast(e.message, 'err', { title: 'Salin gagal' });
    } finally {
      tab.running = false;
      renderSummary();
    }
  };

  await Promise.all([loadSrc(), loadDst()]);
  if (st.dstId === st.srcId && st.dstNs === st.srcNs && connById(st.dstId).type !== 'sqlite') {
    const other = (await namespacesOf(st.dstId)).find((n) => n !== st.srcNs && !['information_schema', 'mysql', 'performance_schema', 'sys', 'pg_catalog'].includes(n));
    if (other) {
      st.dstNs = other;
      dstNsSel.value = other;
      loadDstTables();
    }
  }
}

// Duplicate a table inside the current database.
export async function duplicateTable(name) {
  const a = state.active;
  const newName = await (await import('./core.js')).promptDialog({ title: 'Duplikat tabel', label: 'Nama tabel baru', value: `${name}_copy`, icon: 'copy' });
  if (!newName) return;
  const job = await api('POST', '/api/jobs/copy', { srcId: a.conn.id, srcNs: a.ns, dstId: a.conn.id, dstNs: a.ns, tables: [{ name, targetName: newName }], mode: 'both', foreignKeys: true });
  toast(`Menduplikat ${name} → ${newName}…`);
  const j = await watchJob(job);
  if (j.status === 'done') {
    toast(`${fmtNum(j.result.rows)} baris`, 'ok', { title: `${newName} dibuat` });
    await app.loadTree();
    app.openTableTab(newName);
  } else toast(j.error, 'err', { title: 'Duplikat gagal' });
}

Object.assign(app, { openCopy, duplicateTable });
