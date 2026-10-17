// Schema compare & sync between two databases/schemas of the same engine.
import { h, icon, esc, api, state, app, toast, sqlPreview, toggle, checkbox, connById, TYPE_LABEL, nsLabel } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { namespacesOf, defaultNsFor, connSelect } from './conn.js';
import { countUp } from './fx.js';

const STATUS = {
  same: ['ok', 'check', 'Sama'],
  different: ['warn', 'git-compare', 'Berbeda'],
  missing: ['info', 'plus', 'Belum ada di target'],
  extra: ['danger', 'minus', 'Hanya di target'],
};

export async function openCompare() {
  if (!state.conns.length) return toast('Belum ada koneksi', 'err');
  const prev = findTab((t) => t.kind === 'compare');
  if (prev) return activateTab(prev.id);
  const a = state.active;
  const st = { srcId: a?.conn.id || state.conns[0].id, srcNs: a?.ns, dstId: a?.conn.id || state.conns[0].id, dstNs: null, drops: false, items: [], pick: new Set() };
  const panel = h('div');
  const srcNs = h('select', { class: 'select' });
  const dstNs = h('select', { class: 'select' });
  const fill = async (sel, id, cur) => {
    const conn = connById(id);
    sel.innerHTML = '';
    if (conn.type === 'sqlite') {
      sel.append(h('option', { value: 'main' }, 'main (file)'));
      sel.disabled = true;
      return 'main';
    }
    sel.disabled = false;
    const list = await namespacesOf(id);
    const ns = cur && list.includes(cur) ? cur : defaultNsFor(conn, list);
    for (const n of list) sel.append(h('option', { value: n, selected: n === ns }, n));
    return ns;
  };
  const srcConn = connSelect(st.srcId, async (v) => ((st.srcId = v), (st.srcNs = await fill(srcNs, v))));
  const dstConn = connSelect(st.dstId, async (v) => ((st.dstId = v), (st.dstNs = await fill(dstNs, v))));
  srcNs.onchange = () => (st.srcNs = srcNs.value);
  dstNs.onchange = () => (st.dstNs = dstNs.value);
  const go = h('button', { class: 'btn primary', html: icon('git-compare') + '<span>Bandingkan</span>' });
  const applyBtn = h('button', { class: 'btn primary', html: icon('wand-sparkles') + '<span>Sinkronkan target</span>', hidden: true });
  const summary = h('div', { class: 'row wrap' });
  const list = h('div', { style: { marginTop: '14px' } });

  panel.append(
    h(
      'div',
      { class: 'scroll-pad' },
      h('div', { style: { font: '700 22px var(--display)' }, text: 'Bandingkan & sinkronkan skema' }),
      h('div', { class: 'faint', style: { marginBottom: '16px' }, text: 'Bandingkan struktur dua database (engine sama), lalu buat SQL untuk menyamakan target dengan sumber.' }),
      h(
        'div',
        { class: 'two-col' },
        h('div', { class: 'card' }, h('div', { class: 'card-title', html: icon('database') + 'Sumber (acuan)' }), h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { text: 'Koneksi' }), srcConn), h('div', { class: 'field' }, h('label', { text: 'Database / schema' }), srcNs))),
        h('div', { class: 'card' }, h('div', { class: 'card-title', html: icon('target') + 'Target (diubah)' }), h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { text: 'Koneksi' }), dstConn), h('div', { class: 'field' }, h('label', { text: 'Database / schema' }), dstNs))),
      ),
      h('div', { class: 'row', style: { marginTop: '14px' } }, toggle('Sertakan DROP TABLE untuk tabel yang hanya ada di target', false, (v) => (st.drops = v)), h('span', { class: 'spacer' }), go),
      h('div', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'row' }, summary, h('span', { class: 'spacer' }), applyBtn), list),
    ),
  );
  summary.append(h('span', { class: 'faint', text: 'Pilih sumber & target lalu klik Bandingkan.' }));
  const tab = { kind: 'compare', icon: 'git-compare', title: 'Schema compare', panel };
  addTab(tab);

  go.onclick = async () => {
    const s = connById(st.srcId);
    const d = connById(st.dstId);
    if (s.type !== d.type) return toast(`${TYPE_LABEL[s.type]} ≠ ${TYPE_LABEL[d.type]} — untuk lintas engine gunakan "Salin tabel".`, 'err', { title: 'Engine berbeda' });
    if (st.srcId === st.dstId && st.srcNs === st.dstNs) return toast('Sumber dan target sama', 'err');
    go.classList.add('loading');
    list.innerHTML = '';
    for (let i = 0; i < 5; i++) list.append(h('div', { class: 'skeleton', style: { height: '40px', marginBottom: '8px' } }));
    try {
      st.items = await api('POST', '/api/compare', { srcId: st.srcId, srcNs: st.srcNs, dstId: st.dstId, dstNs: st.dstNs, includeDrops: st.drops });
      st.pick = new Set(st.items.filter((i) => i.statements.length && i.status !== 'extra').map((i) => i.table));
      render();
    } catch (e) {
      list.innerHTML = '';
      toast(e.message, 'err');
    } finally {
      go.classList.remove('loading');
    }
  };

  function render() {
    summary.innerHTML = '';
    const counts = {};
    for (const i of st.items) counts[i.status] = (counts[i.status] || 0) + 1;
    for (const [k, [cls, ico, label]] of Object.entries(STATUS)) {
      const n = h('b', { class: 'count-up' });
      summary.append(h('span', { class: `chip ${cls}`, style: { height: '26px' } }, h('span', { html: icon(ico) }), n, ` ${label}`));
      countUp(n, counts[k] || 0);
    }
    list.innerHTML = '';
    const sorted = [...st.items].sort((x, y) => (x.status === 'same') - (y.status === 'same'));
    sorted.forEach((it, i) => {
      const [cls, ico, label] = STATUS[it.status];
      const pre = h('pre', { hidden: true, text: it.statements.join('\n\n') || '-- tidak ada perubahan' });
      const cb = it.statements.length ? checkbox('', st.pick.has(it.table), (v) => (v ? st.pick.add(it.table) : st.pick.delete(it.table), updateApply())) : h('span', { style: { width: '16px' } });
      const head = h('div', { class: 'cmp-head' }, cb, h('span', { class: `chip ${cls}`, html: icon(ico) + label }), h('b', { class: 'mono', text: it.table }), h('span', { class: 'faint', text: it.statements.length ? `${it.statements.length} statement` : '' }), h('span', { class: 'spacer' }), it.statements.length ? h('span', { html: icon('chevron-down') }) : null);
      head.onclick = (e) => {
        if (e.target.closest('.check')) return;
        pre.hidden = !pre.hidden;
      };
      list.append(h('div', { class: 'cmp-item', style: { '--i': i } }, head, pre, ...(it.warnings || []).map((w) => h('div', { class: 'notice warn', style: { margin: '0 12px 10px' }, html: icon('triangle-alert') + esc(w) }))));
    });
    if (!sorted.length) list.append(h('div', { class: 'empty', text: 'Tidak ada tabel.' }));
    updateApply();
  }
  function updateApply() {
    const stmts = st.items.filter((i) => st.pick.has(i.table)).flatMap((i) => i.statements);
    applyBtn.hidden = !stmts.length;
    applyBtn.querySelector('span').textContent = `Sinkronkan target (${stmts.length})`;
  }
  applyBtn.onclick = async () => {
    // Missing tables first (they may be FK targets), FK additions last.
    const order = (i) => (i.table === '(foreign keys)' ? 3 : i.status === 'missing' ? 0 : i.status === 'different' ? 1 : 2);
    const stmts = st.items.filter((i) => st.pick.has(i.table)).sort((x, y) => order(x) - order(y)).flatMap((i) => i.statements);
    const d = connById(st.dstId);
    const ok = await sqlPreview({ title: `Sinkronkan ${d.name}${d.type !== 'sqlite' ? ' / ' + st.dstNs : ''}`, sub: `${stmts.length} statement · ${nsLabel(d.type)} target akan diubah`, statements: stmts, connId: st.dstId, ns: st.dstNs, type: d.type, confirmLabel: 'Sinkronkan' });
    if (ok) {
      toast('Target sekarang sesuai sumber', 'ok', { title: 'Sinkron' });
      if (state.active?.conn.id === st.dstId) app.loadTree();
      go.click();
    }
  };

  [st.srcNs, st.dstNs] = await Promise.all([fill(srcNs, st.srcId, st.srcNs), fill(dstNs, st.dstId, null)]);
  const others = (await namespacesOf(st.dstId).catch(() => [])).filter((n) => n !== st.srcNs && !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(n));
  if (st.dstId === st.srcId && others.length && connById(st.dstId).type !== 'sqlite') {
    st.dstNs = others[0];
    dstNs.value = others[0];
  }
}

Object.assign(app, { openCompare });
