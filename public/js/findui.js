// "Search database": search a value across every table and column of the active namespace.
import { h, icon, esc, api, state, app, toast, watchJob, segmented, toggle, fmtNum, quoteIdent, sqlLiteral, valStr } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { renderGrid } from './grid.js';
import { countUp } from './fx.js';
import { t, plural } from './i18n.js';

export function openFinder({ term = '' } = {}) {
  const a = state.active;
  if (!a) return;
  const prev = findTab((tb) => tb.kind === 'finder' && tb.connId === a.conn.id && tb.ns === a.ns);
  if (prev) {
    activateTab(prev.id);
    if (term) prev.search(term);
    return;
  }
  const panel = h('div');
  const input = h('input', { class: 'finder-input', placeholder: t('Search for a value across all tables… (e.g. name, email, code)'), value: term, spellcheck: 'false' });
  let match = 'contains';
  const seg = segmented(
    [
      { value: 'contains', label: t('Contains') },
      { value: 'starts', label: t('Starts with') },
      { value: 'exact', label: t('Exact') },
    ],
    match,
    (v) => (match = v),
  );
  const cs = toggle(t('Case sensitive'), false);
  const goBtn = h('button', { class: 'btn primary', html: icon('search') + `<span>${t('Search')}</span>` });
  const status = h('div', { class: 'finder-status' });
  const results = h('div', { class: 'finder-results' });
  panel.append(
    h(
      'div',
      { class: 'scroll-pad' },
      h(
        'div',
        { class: 'finder-hero' },
        h('div', { class: 'fh-orb', html: icon('search-code') }),
        h('div', { class: 'finder-box' }, h('span', { html: icon('search') }), input, goBtn),
        h('div', { class: 'row wrap', style: { justifyContent: 'center', marginTop: '12px' } }, seg, cs),
        status,
      ),
      results,
    ),
  );
  const tab = { kind: 'finder', icon: 'search-code', title: t('Search database'), panel, connId: a.conn.id, ns: a.ns, search: (tb) => ((input.value = tb), run()) };
  addTab(tab);

  async function run() {
    const termNow = input.value.trim();
    if (!termNow) return input.focus();
    goBtn.classList.add('loading');
    results.innerHTML = '';
    status.innerHTML = `<div class="progress"><i style="--p:0%"></i></div><div class="faint" style="margin-top:6px">${t('Scanning…')}</div>`;
    try {
      const job = await api('POST', '/api/jobs/find', { connId: a.conn.id, ns: a.ns, term: termNow, match, caseSensitive: cs.input.checked });
      const j = await watchJob(job, (x) => {
        status.querySelector('i')?.style.setProperty('--p', `${Math.round(x.progress * 100)}%`);
        const ph = status.querySelector('.faint');
        if (ph) ph.textContent = x.phase;
      });
      if (j.status !== 'done') throw new Error(j.error || t('Cancelled'));
      render(j.result);
    } catch (e) {
      status.innerHTML = '';
      results.append(h('div', { class: 'result-error', text: e.message }));
    } finally {
      goBtn.classList.remove('loading');
    }
  }

  function render(r) {
    const n = h('b', { class: 'count-up', text: '0' });
    status.innerHTML = '';
    status.append(h('div', { class: 'finder-sum' }, n, h('span', { html: ' ' + plural(r.hits, 'match in <b>{found}</b> of {total} tables for “{term}”', 'matches in <b>{found}</b> of {total} tables for “{term}”', { found: fmtNum(r.results.length), total: fmtNum(r.tables), term: esc(r.term) }) })));
    countUp(n, r.hits, 800);
    if (!r.results.length) {
      results.append(h('div', { class: 'empty', html: `${icon('search-x')}<div>${t('Nothing found.')}</div>` }));
      return;
    }
    r.results.forEach((tb, i) => {
      const gw = h('div', { class: 'grid-wrap', style: { maxHeight: '260px' } });
      const filter = tb.matched.map((c) => (r.match === 'exact' ? `${quoteIdent(c, a.conn.type)} = ${sqlLiteral(r.term)}` : `${quoteIdent(c, a.conn.type)} LIKE ${sqlLiteral(r.match === 'starts' ? r.term + '%' : '%' + r.term + '%')}`)).join(' OR ');
      const card = h(
        'div',
        { class: 'finder-card', style: { '--i': i } },
        h(
          'div',
          { class: 'fc-head' },
          h('span', { html: icon('table-2') }),
          h('b', { class: 'mono', text: tb.table }),
          h('span', { class: 'chip ok', text: plural(tb.count, '{n} row', '{n} rows') }),
          h('span', { class: 'faint', html: plural(tb.matched.length, 'in column {cols}', 'in columns {cols}', { cols: tb.matched.map((c) => `<span class="mono">${esc(c)}</span>`).join(', ') || '–' }) }),
          h('span', { class: 'spacer' }),
          h('button', {
            class: 'btn sm',
            html: icon('table') + `<span>${t('Open with filter')}</span>`,
            onclick: async () => {
              const tt = app.openTableTab(tb.table);
              if (tt && filter) {
                tt.filter = filter;
                tt.ui.filterInput.value = filter;
                tt.ui.filterInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
              }
            },
          }),
        ),
        gw,
      );
      results.append(card);
      const needle = cs.input.checked ? r.term : r.term.toLowerCase();
      renderGrid(gw, {
        columns: tb.columns,
        rows: tb.rows,
        animate: i < 3,
        cellClass: (ri, ci) => {
          const v = tb.rows[ri][ci];
          if (v == null) return '';
          const s = cs.input.checked ? valStr(v) : valStr(v).toLowerCase();
          return (r.match === 'exact' ? s === needle : r.match === 'starts' ? s.startsWith(needle) : s.includes(needle)) ? 'hit' : '';
        },
      });
    });
  }

  goBtn.onclick = run;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  setTimeout(() => input.focus(), 80);
  if (term) run();
}

Object.assign(app, { openFinder });
void toast;
