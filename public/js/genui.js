// Test-data generator UI.
import { h, icon, esc, api, qs, state, app, toast, watchJob, checkbox, confirmDialog, fmtNum, debounce, segmented, valStr } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { progressRing } from './copytool.js';
import { t, plural } from './i18n.js';

const OPTION_FIELDS = {
  int: [['min', t('Min'), 'number'], ['max', t('Max'), 'number']],
  year: [['min', t('From'), 'number'], ['max', t('To'), 'number']],
  decimal: [['min', t('Min'), 'number'], ['max', t('Max'), 'number'], ['scale', t('Decimals'), 'number']],
  money: [['min', t('Min (Rp)'), 'number'], ['max', t('Max (Rp)'), 'number']],
  date: [['from', t('From'), 'date'], ['to', t('To'), 'date']],
  datetime: [['from', t('From'), 'date'], ['to', t('To'), 'date']],
  sequence: [['prefix', t('Prefix'), 'text'], ['start', t('Start'), 'number'], ['width', t('Digits'), 'number']],
  constant: [['value', t('Value'), 'text']],
  bool: [['trueRatio', t('TRUE ratio (0–1)'), 'number']],
};
let GEN_LABELS = null;

export async function openDataGen({ table } = {}) {
  const a = state.active;
  if (!a) return;
  const prev = findTab((tb) => tb.kind === 'datagen' && tb.connId === a.conn.id && tb.ns === a.ns);
  if (prev) {
    activateTab(prev.id);
    if (table) prev.focusTable(table);
    return;
  }
  GEN_LABELS ||= await api('GET', '/api/datagen/generators');
  const tables = state.tables.filter((tb) => tb.kind === 'table').map((tb) => tb.name);
  const reqs = new Map(); // table -> { on, rows, mode }
  const plans = new Map();
  const overrides = new Map(); // table -> { col: spec }
  let focused = table || tables[0];
  if (table) reqs.set(table, { on: true, rows: 100, mode: 'append' });

  const panel = h('div');
  const left = h('div', { class: 'gen-tables' });
  const right = h('div', { class: 'gen-cols' });
  const seed = h('input', { class: 'input sm', type: 'number', placeholder: t('random'), style: { width: '110px' }, title: t('The same seed produces the same data') });
  const goBtn = h('button', { class: 'btn primary', html: icon('wand-sparkles') + `<span>${t('Generate')}</span>` });
  const summary = h('span', { class: 'faint' });
  const ring = progressRing(70);
  const runBox = h('div', { class: 'gen-run', hidden: true }, ring, h('div', { class: 'grow' }, h('b', { text: t('Generating data…') }), h('div', { class: 'faint run-phase' })));
  panel.append(
    h('div', { class: 'page-head', style: { padding: '16px 16px 0' } }, h('div', { class: 'ph-ico', html: icon('wand-sparkles') }), h('div', {}, h('h2', { text: t('Data generator') }), h('p', { class: 'faint', text: t('Fill tables in {target} with realistic test data — types, column lengths, UNIQUE, ENUM/CHECK and FK relations are respected.', { target: a.conn.type === 'sqlite' ? a.conn.name : a.ns }) }))),
    h('div', { class: 'gen-layout' }, left, right),
    h('div', { class: 'gen-foot glass' }, summary, h('span', { class: 'spacer' }), runBox, h('label', { class: 'faint', text: t('Seed') }), seed, goBtn),
  );
  const tab = { kind: 'datagen', icon: 'wand-sparkles', title: t('Data generator'), panel, connId: a.conn.id, ns: a.ns, focusTable: (tb) => focus(tb) };
  addTab(tab);

  function renderLeft() {
    left.innerHTML = '';
    left.append(h('div', { class: 'section-label', style: { margin: '4px 4px 8px' }, text: t('Tables') }));
    tables.forEach((tb, i) => {
      const r = reqs.get(tb) || { on: false, rows: 100, mode: 'append' };
      const rows = h('input', { class: 'input sm', type: 'number', min: 1, max: 1000000, value: r.rows, style: { width: '84px' } });
      rows.oninput = () => (reqs.set(tb, { ...(reqs.get(tb) || r), rows: Number(rows.value) || 0, on: true }), sync());
      const mode = h('select', { class: 'select sm', style: { width: '96px' }, title: t('Add to the existing data, or empty the table first') }, h('option', { value: 'append', selected: r.mode === 'append' }, t('Append')), h('option', { value: 'replace', selected: r.mode === 'replace' }, t('Replace')));
      mode.onchange = () => (reqs.set(tb, { ...(reqs.get(tb) || r), mode: mode.value, on: true }), sync());
      const row = h(
        'div',
        { class: 'gen-t' + (tb === focused ? ' focused' : '') + (r.on ? ' on' : ''), style: { '--i': i } },
        checkbox('', r.on, (v) => (reqs.set(tb, { ...(reqs.get(tb) || r), on: v }), sync())),
        h('span', { class: 'gt-name mono', text: tb }),
        rows,
        mode,
      );
      row.onclick = (e) => !e.target.closest('input, select, .check') && focus(tb);
      left.append(row);
    });
    sync();
  }
  function sync() {
    const on = [...reqs].filter(([, r]) => r.on && r.rows > 0);
    const n = on.reduce((s, [, r]) => s + r.rows, 0);
    summary.innerHTML = on.length ? `${plural(on.length, '<b>{n}</b> table', '<b>{n}</b> tables')} · ${plural(n, '<b>{n}</b> row will be created', '<b>{n}</b> rows will be created')}${on.some(([, r]) => r.mode === 'replace') ? ` · <span class="warn-text">${t('some tables will be emptied first')}</span>` : ''}` : t('Check the tables you want to fill');
    goBtn.disabled = !on.length;
    left.querySelectorAll('.gen-t').forEach((el, i) => el.classList.toggle('on', Boolean(reqs.get(tables[i])?.on)));
  }

  async function focus(tb) {
    focused = tb;
    left.querySelectorAll('.gen-t').forEach((el, i) => el.classList.toggle('focused', tables[i] === tb));
    right.innerHTML = '';
    for (let i = 0; i < 6; i++) right.append(h('div', { class: 'skeleton', style: { height: '44px', margin: '10px 0' } }));
    try {
      if (!plans.has(tb)) plans.set(tb, await api('GET', `/api/c/${a.conn.id}/datagen/plan${qs({ ns: a.ns, table: tb })}`));
    } catch (e) {
      right.innerHTML = '';
      return right.append(h('div', { class: 'result-error', text: e.message }));
    }
    if (focused !== tb) return;
    renderCols(plans.get(tb));
  }

  function renderCols(plan) {
    right.innerHTML = '';
    const ov = overrides.get(plan.table) || {};
    overrides.set(plan.table, ov);
    right.append(
      h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', { class: 'gen-title mono', text: plan.table }), h('span', { class: 'chip', text: plural(plan.rows, '{n} row now', '{n} rows now') }), plan.foreignKeys.length ? h('span', { class: 'chip info', html: `${icon('link-2')} ${plural(plan.foreignKeys.length, '{n} relation', '{n} relations')}` }) : null),
    );
    plan.columns.forEach((c, i) => {
      const spec = { ...c.spec, ...(ov[c.name] || {}) };
      const samples = h('div', { class: 'gen-samples' });
      const opts = h('div', { class: 'gen-opts' });
      const sel = h('select', { class: 'select sm' });
      for (const [k, label] of Object.entries(GEN_LABELS)) {
        if (k === 'fk' && !c.spec.fk) continue;
        if (k === 'list' && !c.list && spec.gen !== 'list') continue;
        sel.append(h('option', { value: k, selected: k === spec.gen }, label));
      }
      const refresh = debounce(async () => {
        const s = { ...c.spec, ...(ov[c.name] || {}) };
        samples.classList.add('loading');
        if (s.gen === 'skip') samples.innerHTML = `<span class="faint">${c.autoIncrement ? t('filled automatically by the database') : c.hasDefault ? t('uses the default value') : t('left empty/default')}</span>`;
        else if (s.gen === 'fk') samples.innerHTML = `<span class="chip info">${icon('link-2')} ${t('random from {ref}', { ref: `${esc(s.fk?.table)}.${esc(s.fk?.column)}` })}</span>`;
        else {
          try {
            const r = await api('POST', '/api/datagen/sample', { spec: s });
            samples.innerHTML = r.values.map((v) => `<span class="gs">${esc(v == null ? 'NULL' : valStr(v)).slice(0, 60)}</span>`).join('');
          } catch {
            samples.textContent = '';
          }
        }
        samples.classList.remove('loading');
      }, 200);
      const renderOpts = () => {
        opts.innerHTML = '';
        const s = { ...c.spec, ...(ov[c.name] || {}) };
        for (const [key, label, type] of OPTION_FIELDS[s.gen] || []) {
          const inp = h('input', { class: 'input sm', type, value: s[key] ?? '', placeholder: label, title: label, style: { width: type === 'date' ? '140px' : '96px' } });
          inp.oninput = () => {
            ov[c.name] = { ...(ov[c.name] || {}), gen: s.gen, [key]: type === 'number' ? Number(inp.value) : inp.value };
            refresh();
          };
          opts.append(inp);
        }
        if (s.gen === 'list' || s.gen === 'status') {
          const inp = h('input', { class: 'input sm', value: (s.values || c.list || []).join(', '), placeholder: t('value1, value2, …'), style: { minWidth: '200px' } });
          inp.oninput = () => {
            ov[c.name] = { ...(ov[c.name] || {}), gen: s.gen, values: inp.value.split(',').map((x) => x.trim()).filter(Boolean) };
            refresh();
          };
          opts.append(inp);
        }
        if (c.nullable && !['skip', 'null', 'fk'].includes(s.gen)) {
          const nr = h('input', { type: 'range', min: 0, max: 100, value: Math.round((s.nullRatio || 0) * 100), class: 'gen-null', title: t('NULL percentage') });
          const lbl = h('span', { class: 'faint', text: `NULL ${nr.value}%` });
          nr.oninput = () => {
            lbl.textContent = `NULL ${nr.value}%`;
            ov[c.name] = { ...(ov[c.name] || {}), gen: s.gen, nullRatio: Number(nr.value) / 100 };
          };
          opts.append(h('span', { class: 'row', style: { gap: '6px' } }, nr, lbl));
        }
      };
      sel.onchange = () => {
        ov[c.name] = { ...(ov[c.name] || {}), gen: sel.value };
        renderOpts();
        refresh();
      };
      const badges = [
        c.pk ? `<span class="chip warn">${icon('key-round')}PK</span>` : '',
        c.unique && !c.pk ? '<span class="chip">UNIQUE</span>' : '',
        c.autoIncrement ? '<span class="chip ok">AUTO</span>' : '',
        c.spec.fk ? `<span class="chip info">${icon('link-2')}${esc(c.spec.fk.table)}</span>` : '',
        c.list ? `<span class="chip">${plural(c.list.length, '{n} option', '{n} options')}</span>` : '',
      ].join('');
      right.append(
        h(
          'div',
          { class: 'gen-col', style: { '--i': i } },
          h('div', { class: 'gc-name' }, h('b', { class: 'mono', text: c.name }), h('span', { class: 'faint mono', text: c.type }), h('div', { class: 'row wrap', style: { gap: '4px' }, html: badges })),
          h('div', { class: 'gc-gen' }, sel, opts),
          samples,
        ),
      );
      renderOpts();
      refresh();
    });
  }

  goBtn.onclick = async () => {
    const list = [...reqs].filter(([, r]) => r.on && r.rows > 0).map(([tb, r]) => ({ table: tb, rows: r.rows, mode: r.mode, columns: overrides.get(tb) || {} }));
    if (list.some((x) => x.mode === 'replace')) {
      const ok = await confirmDialog({ title: t('Empty tables first?'), message: plural(list.filter((x) => x.mode === 'replace').length, 'Table <b>{tables}</b> will be emptied before being filled with test data.', 'Tables <b>{tables}</b> will be emptied before being filled with test data.', { tables: list.filter((x) => x.mode === 'replace').map((x) => esc(x.table)).join(', ') }), danger: true, confirmLabel: t('Yes, replace data') });
      if (!ok) return;
    }
    goBtn.disabled = true;
    runBox.hidden = false;
    try {
      const job = await api('POST', '/api/jobs/datagen', { connId: a.conn.id, ns: a.ns, tables: list, seed: seed.value ? Number(seed.value) : undefined });
      const j = await watchJob(job, (x) => {
        ring.set(x.progress);
        runBox.querySelector('.run-phase').textContent = x.phase;
      });
      if (j.status !== 'done') throw new Error(j.error || t('Cancelled'));
      toast(j.result.tables.map((x) => `${x.table}: ${fmtNum(x.inserted)}`).join(' · '), 'ok', { title: plural(j.result.rows, '{n} row of test data created', '{n} rows of test data created') });
      plans.clear();
      app.loadTree();
      focus(focused);
    } catch (e) {
      toast(e.message, 'err', { title: t('Generator failed') });
    } finally {
      goBtn.disabled = false;
      runBox.hidden = true;
    }
  };

  renderLeft();
  if (focused) focus(focused);
  void segmented;
}

Object.assign(app, { openDataGen });
