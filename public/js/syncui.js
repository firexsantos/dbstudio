// Data synchronization UI: compare rows by primary key, review diffs, apply or export a script.
import { h, icon, esc, api, qs, state, app, toast, watchJob, download, checkbox, confirmDialog, connById, fmtNum, TYPE_LABEL, nsLabel, engineBadge, valStr } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { namespacesOf, defaultNsFor, connSelect } from './conn.js';
import { progressRing } from './copytool.js';
import { countUp } from './fx.js';
import { t, plural } from './i18n.js';

const KINDS = [
  ['insert', t('Insert'), 'plus', 'ok', (n) => plural(n, '{n} insert', '{n} inserts')],
  ['update', t('Update'), 'pencil', 'warn', (n) => plural(n, '{n} update', '{n} updates')],
  ['delete', t('Delete'), 'minus', 'danger', (n) => plural(n, '{n} delete', '{n} deletes')],
];
const SEG_LABEL = { insert: t('Insert'), update: t('Update'), delete: t('Delete'), same: t('Same') };

export async function openDataSync() {
  if (!state.conns.length) return toast(t('No connections yet'), 'err');
  const prev = findTab((tb) => tb.kind === 'datasync');
  if (prev) return activateTab(prev.id);
  const a = state.active;
  const st = { srcId: a?.conn.id || state.conns[0].id, srcNs: a?.ns, dstId: a?.conn.id || state.conns[0].id, dstNs: null, tables: [], dstTables: new Set(), pick: new Set(), result: null, compareId: null, sel: new Map() };

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
  const srcConn = connSelect(st.srcId, async (v) => ((st.srcId = v), (st.srcNs = await fill(srcNs, v)), loadTables()));
  const dstConn = connSelect(st.dstId, async (v) => ((st.dstId = v), (st.dstNs = await fill(dstNs, v)), loadTables()));
  srcNs.onchange = () => ((st.srcNs = srcNs.value), loadTables());
  dstNs.onchange = () => ((st.dstNs = dstNs.value), loadTables());

  const mapList = h('div', { class: 'table-pick' });
  const allBox = checkbox(t('Select all matching'), true, (v) => {
    st.tables.forEach((tb) => (v && st.dstTables.has(tb.name) ? st.pick.add(tb.name) : st.pick.delete(tb.name)));
    renderMap();
  });
  const go = h('button', { class: 'btn primary', html: icon('scan-search') + `<span>${t('Compare data')}</span>` });
  const ring = progressRing(86);
  const phase = h('div', { class: 'faint' });
  const runCard = h('div', { class: 'card big-progress', hidden: true, style: { marginTop: '14px' } }, ring, h('div', { class: 'grow' }, h('b', { text: t('Comparing…') }), phase));
  const results = h('div');

  panel.append(
    h(
      'div',
      { class: 'scroll-pad' },
      h('div', { class: 'page-head' }, h('div', { class: 'ph-ico', html: icon('arrow-left-right') }), h('div', {}, h('h2', { text: t('Data sync') }), h('p', { class: 'faint', text: t('Compare table contents row by row (by primary key), then make the target match the source — works across servers & engines.') }))),
      h(
        'div',
        { class: 'two-col sync-ends' },
        h('div', { class: 'card' }, h('div', { class: 'card-title', html: icon('database') + t('Source (reference)') }), h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { text: t('Connection') }), srcConn), h('div', { class: 'field' }, h('label', { class: 'src-l', text: t('Database') }), srcNs))),
        h('div', { class: 'card' }, h('div', { class: 'card-title', html: icon('target') + t('Target (will be changed)') }), h('div', { class: 'form-grid' }, h('div', { class: 'field' }, h('label', { text: t('Connection') }), dstConn), h('div', { class: 'field' }, h('label', { class: 'dst-l', text: t('Database') }), dstNs))),
      ),
      h('div', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'row', style: { marginBottom: '10px' } }, h('div', { class: 'card-title', style: { margin: 0 }, html: icon('table-2') + t('Tables') }), h('span', { class: 'spacer' }), allBox, go), mapList),
      runCard,
      results,
    ),
  );
  const tab = { kind: 'datasync', icon: 'arrow-left-right', title: t('Data sync'), panel };
  addTab(tab);

  async function loadTables() {
    mapList.innerHTML = '<div class="skeleton" style="height:90px;margin:10px"></div>';
    panel.querySelector('.src-l').textContent = nsLabel(connById(st.srcId).type);
    panel.querySelector('.dst-l').textContent = nsLabel(connById(st.dstId).type);
    try {
      const [src, dst] = await Promise.all([api('GET', `/api/c/${st.srcId}/tables${qs({ ns: st.srcNs })}`), api('GET', `/api/c/${st.dstId}/tables${qs({ ns: st.dstNs })}`)]);
      st.tables = src.filter((tb) => tb.kind === 'table');
      st.dstTables = new Set(dst.filter((tb) => tb.kind === 'table').map((tb) => tb.name));
      st.pick = new Set(st.tables.filter((tb) => st.dstTables.has(tb.name)).map((tb) => tb.name));
      renderMap();
    } catch (e) {
      mapList.innerHTML = '';
      mapList.append(h('div', { class: 'result-error', text: e.message }));
    }
  }
  function renderMap() {
    mapList.innerHTML = '';
    if (!st.tables.length) return mapList.append(h('div', { class: 'empty', text: t('The source has no tables') }));
    st.tables.forEach((tb, i) => {
      const ok = st.dstTables.has(tb.name);
      mapList.append(
        h(
          'div',
          { class: 'tp-row', style: { '--i': i } },
          ok ? checkbox('', st.pick.has(tb.name), (v) => (v ? st.pick.add(tb.name) : st.pick.delete(tb.name))) : h('span', { html: icon('ban'), class: 'faint' }),
          h('span', { text: tb.name }),
          h('span', { class: 'flow-arrow', html: icon('arrow-right') }),
          ok ? h('span', { class: 'chip ok', html: `${icon('check')} ${esc(tb.name)}` }) : h('span', { class: 'chip warn', html: `${icon('circle-alert')} ${t('not in target')}` }),
        ),
      );
    });
  }

  go.onclick = async () => {
    if (st.srcId === st.dstId && st.srcNs === st.dstNs) return toast(t('Source and target are the same'), 'err');
    const tables = [...st.pick].map((name) => ({ name }));
    if (!tables.length) return toast(t('Select at least one table'), 'err');
    go.disabled = true;
    runCard.hidden = false;
    results.innerHTML = '';
    try {
      const job = await api('POST', '/api/jobs/datasync/compare', { srcId: st.srcId, srcNs: st.srcNs, dstId: st.dstId, dstNs: st.dstNs, tables });
      const j = await watchJob(job, (x) => {
        ring.set(x.progress);
        phase.textContent = x.phase;
      });
      runCard.hidden = true;
      if (j.status !== 'done') return toast(j.error || t('Cancelled'), 'err', { title: t('Comparison failed') });
      st.result = j.result;
      st.compareId = j.id;
      st.sel = new Map(j.result.tables.filter((tb) => !tb.error).map((tb) => [tb.table, { table: tb.table, insert: true, update: true, delete: false }]));
      renderResults();
    } catch (e) {
      runCard.hidden = true;
      toast(e.message, 'err');
    } finally {
      go.disabled = false;
    }
  };

  function renderResults() {
    results.innerHTML = '';
    const tabs = st.result.tables;
    const sum = { insert: 0, update: 0, delete: 0, same: 0 };
    tabs.forEach((tb) => Object.keys(sum).forEach((k) => (sum[k] += tb[k] || 0)));
    const stats = h('div', { class: 'sync-stats' });
    for (const [k, label, ico, cls] of [...KINDS, ['same', t('Same'), 'equal', '']]) {
      const n = h('b', { class: 'count-up', text: '0' });
      stats.append(h('div', { class: `sync-stat ${cls}` }, h('span', { class: 'ss-ico', html: icon(ico) }), n, h('span', { text: label })));
      countUp(n, sum[k], 900);
    }
    const list = h('div', { class: 'sync-list' });
    tabs.forEach((tb, i) => list.append(tableRow(tb, i)));
    const scriptBtn = h('button', { class: 'btn', html: icon('file-code-2') + `<span>${t('Save SQL script')}</span>` });
    const applyBtn = h('button', { class: 'btn primary', html: icon('git-merge') + `<span>${t('Apply to target')}</span>` });
    scriptBtn.onclick = () => run('script', scriptBtn);
    applyBtn.onclick = () => run('apply', applyBtn);
    const inSync = !sum.insert && !sum.update && !sum.delete;
    results.append(
      ...[
      h('div', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'card-title', html: icon('chart-bar-stacked') + t('Comparison result') }), stats),
      inSync ? h('div', { class: 'notice info', style: { marginTop: '14px' }, html: `${icon('circle-check-big')}<div>${t('<b>Data is already in sync.</b> Nothing to synchronize.')}</div>` }) : null,
      list,
      inSync ? null : h('div', { class: 'sync-actions glass' }, h('div', { class: 'faint', html: `${icon('info')} ${t('Deleting rows in the target is <b>not</b> checked by default.')}` }), h('span', { class: 'spacer' }), scriptBtn, applyBtn),
      ].filter(Boolean),
    );
  }

  function tableRow(tb, i) {
    const row = h('div', { class: 'sync-row', style: { '--i': i } });
    if (tb.error) {
      row.append(h('div', { class: 'sr-head' }, h('b', { class: 'mono', text: tb.table }), h('span', { class: 'chip warn', html: `${icon('circle-alert')} ${esc(tb.error)}` })));
      return row;
    }
    const sel = st.sel.get(tb.table);
    const total = Math.max(1, tb.insert + tb.update + tb.delete + tb.same);
    const bar = h('div', { class: 'sync-bar' }, ...['insert', 'update', 'delete', 'same'].map((k) => h('i', { class: k, style: { '--w': `${(tb[k] / total) * 100}%` }, title: `${fmtNum(tb[k])} ${SEG_LABEL[k]}` })));
    const chips = h('div', { class: 'row wrap' });
    for (const [k, , ico, cls, count] of KINDS) {
      const c = checkbox('', sel[k] && tb[k] > 0, (v) => (sel[k] = v));
      if (!tb[k]) c.input.disabled = true;
      chips.append(h('span', { class: `chip ${tb[k] ? cls : ''}`, style: { gap: '6px' } }, c, h('span', { html: `${icon(ico)} ${count(tb[k])}` })));
    }
    chips.append(h('span', { class: 'chip', html: `${icon('equal')} ${t('{n} same', { n: fmtNum(tb.same) })}` }));
    const detail = h('div', { class: 'sr-detail', hidden: true });
    const head = h(
      'div',
      { class: 'sr-head' },
      h('span', { html: icon('chevron-right', 'chev') }),
      h('b', { class: 'mono', text: tb.table }),
      tb.target !== tb.table ? h('span', { class: 'faint mono', text: `→ ${tb.target}` }) : null,
      h('span', { class: 'faint', text: t('{src} ↔ {dst} rows · key: {key}', { src: fmtNum(tb.srcRows), dst: fmtNum(tb.dstRows), key: tb.key.join(', ') }) }),
      h('span', { class: 'spacer' }),
      chips,
    );
    head.onclick = (e) => {
      if (e.target.closest('.check')) return;
      detail.hidden = !detail.hidden;
      row.classList.toggle('open', !detail.hidden);
      if (!detail.hidden && !detail.childElementCount) renderDetail(tb, detail);
    };
    row.append(head, bar, detail);
    requestAnimationFrame(() => row.classList.add('in'));
    return row;
  }

  function renderDetail(tb, box) {
    const segs = KINDS.filter(([k]) => tb[k]);
    if (!segs.length) return box.append(h('div', { class: 'faint', style: { padding: '10px' }, text: t('No differences.') }));
    const tabs = h('div', { class: 'row', style: { gap: '4px', marginBottom: '8px' } });
    const view = h('div', { class: 'diff-wrap' });
    const show = (k) => {
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('primary', b.dataset.k === k));
      view.innerHTML = '';
      const cols = tb.columns;
      const tbl = h('table', { class: 'grid diff' });
      tbl.append(h('thead', {}, h('tr', {}, ...(k === 'update' ? [h('th', { text: '' })] : []), ...cols.map((c) => h('th', { text: c })))));
      const body = h('tbody');
      const cell = (v, cls = '') => h('td', { class: cls + (v == null ? ' null' : ''), text: v == null ? 'NULL' : valStr(v).slice(0, 120) });
      if (k === 'update') {
        for (const u of tb.samples.update) {
          const ch = new Set(u.changed);
          body.append(h('tr', { class: 'd-old' }, h('td', { class: 'tag', text: t('target') }), ...cols.map((_, i) => cell(u.dst[i], ch.has(i) ? 'was' : ''))));
          body.append(h('tr', { class: 'd-new' }, h('td', { class: 'tag', text: t('source') }), ...cols.map((_, i) => cell(u.src[i], ch.has(i) ? 'now' : ''))));
        }
      } else for (const r of tb.samples[k]) body.append(h('tr', { class: k === 'insert' ? 'd-ins' : 'd-del' }, ...r.map((v) => cell(v))));
      tbl.append(body);
      view.append(tbl);
      if (tb[k] > tb.samples[k].length) view.append(h('div', { class: 'faint', style: { padding: '8px 4px' }, text: t('Showing {shown} of {total} rows.', { shown: fmtNum(tb.samples[k].length), total: fmtNum(tb[k]) }) }));
    };
    for (const [k, label, ico] of segs) tabs.append(h('button', { class: 'btn xs', 'data-k': k, html: `${icon(ico)}${label} (${fmtNum(tb[k])})`, onclick: () => show(k) }));
    box.append(tabs, view);
    show(segs[0][0]);
  }

  async function run(kind, btn) {
    const selection = [...st.sel.values()];
    const tot = selection.reduce((s, x) => {
      const tb = st.result.tables.find((y) => y.table === x.table);
      return s + (x.insert ? tb.insert : 0) + (x.update ? tb.update : 0) + (x.delete ? tb.delete : 0);
    }, 0);
    if (!tot) return toast(t('No changes are checked'), 'err');
    const dst = connById(st.dstId);
    if (kind === 'apply') {
      const ok = await confirmDialog({
        title: t('Apply sync?'),
        message: plural(tot, '<b>{n}</b> change will be applied to {target}. Backing up the target first is recommended.', '<b>{n}</b> changes will be applied to {target}. Backing up the target first is recommended.', { target: `${engineBadge(dst.type, true)} <b>${esc(dst.name)}</b>${dst.type !== 'sqlite' ? ' / ' + esc(st.dstNs) : ''}` }),
        danger: true,
        confirmLabel: t('Apply'),
        icon: 'git-merge',
      });
      if (!ok) return;
    }
    btn.classList.add('loading');
    try {
      const job = await api('POST', `/api/jobs/datasync/${kind}`, { compareId: st.compareId, selection });
      const j = await watchJob(job);
      if (j.status !== 'done') throw new Error(j.error || t('Cancelled'));
      if (kind === 'script') {
        download(j.download);
        toast(plural(j.result.statements, '{n} statement', '{n} statements'), 'ok', { title: t('Sync script ready') });
      } else {
        toast(plural(j.result.applied, '{n} row changed in the target', '{n} rows changed in the target'), 'ok', { title: t('Sync complete') });
        if (state.active?.conn.id === st.dstId) app.loadTree();
        go.click();
      }
    } catch (e) {
      toast(e.message, 'err', { title: kind === 'apply' ? t('Sync failed') : t('Failed to create script') });
    } finally {
      btn.classList.remove('loading');
    }
  }

  [st.srcNs, st.dstNs] = await Promise.all([fill(srcNs, st.srcId, st.srcNs), fill(dstNs, st.dstId, null)]);
  if (st.srcId === st.dstId && connById(st.dstId).type !== 'sqlite') {
    const other = (await namespacesOf(st.dstId)).find((n) => n !== st.srcNs && !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(n));
    if (other) {
      st.dstNs = other;
      dstNs.value = other;
    }
  }
  loadTables();
  void TYPE_LABEL;
}

Object.assign(app, { openDataSync });
