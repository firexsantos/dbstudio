// Export / import: SQL dump, full-table CSV/JSON, SQL script import, CSV import with column mapping.
import { h, icon, esc, api, qs, state, app, toast, watchJob, download, segmented, toggle, checkbox, select, field, fmtNum, fmtBytes, TYPE_LABEL } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { renderGrid } from './grid.js';
import { t, plural } from './i18n.js';

// RFC 4180 CSV parser with delimiter auto-detection.
export function parseCSV(text, delimiter = 'auto') {
  text = text.replace(/^﻿/, '');
  if (delimiter === 'auto') {
    const first = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
    const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]);
    delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { rows: rows.filter((r) => r.length > 1 || r[0] !== ''), delimiter };
}

function dropzone(accept, label, onFile) {
  const input = h('input', { type: 'file', accept, hidden: true });
  const info = h('div', { class: 'faint', style: { fontSize: '12px' } });
  const z = h('div', { class: 'dropzone', tabindex: 0 }, h('div', { html: icon('cloud-upload') }), h('div', { html: t('<b>{label}</b> — drag it here or click to choose', { label }) }), info, input);
  const take = (f) => {
    if (!f) return;
    z.classList.add('has-file');
    info.innerHTML = `${icon('file-check-2')} ${esc(f.name)} · ${fmtBytes(f.size)}`;
    onFile(f);
  };
  z.onclick = () => input.click();
  input.onchange = () => take(input.files[0]);
  z.addEventListener('dragover', (e) => (e.preventDefault(), z.classList.add('over')));
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => {
    e.preventDefault();
    z.classList.remove('over');
    take(e.dataTransfer.files[0]);
  });
  return z;
}

function jobProgress() {
  const bar = h('div', { class: 'progress', html: '<i></i>' });
  const phase = h('div', { class: 'faint', style: { fontSize: '12px', marginTop: '6px' } });
  const el = h('div', { hidden: true, style: { marginTop: '14px' } }, bar, phase);
  el.update = (j) => {
    el.hidden = false;
    bar.firstChild.style.setProperty('--p', Math.round(j.progress * 100) + '%');
    bar.classList.toggle('done', j.status === 'done');
    bar.classList.toggle('error', j.status === 'error');
    phase.textContent = j.error || j.phase || '';
  };
  return el;
}

export function openTransfer({ tab: which = 'export-sql', table = null } = {}) {
  const a = state.active;
  if (!a) return toast(t('Connect to a database first'), 'err');
  const prev = findTab((t) => t.kind === 'transfer' && t.connId === a.conn.id && t.ns === a.ns);
  if (prev) {
    activateTab(prev.id);
    prev.show(which, table);
    return;
  }
  const type = a.conn.type;
  const tables = () => state.tables.filter((t) => t.kind === 'table').map((t) => t.name);
  const panel = h('div');
  const panes = {};
  const seg = segmented(
    [
      { value: 'export-sql', label: t('Export SQL'), icon: 'file-down' },
      { value: 'export-data', label: t('Export data'), icon: 'sheet' },
      { value: 'import-sql', label: t('Import SQL'), icon: 'file-up' },
      { value: 'import-csv', label: t('Import CSV'), icon: 'table-properties' },
    ],
    which,
    (v) => show(v),
  );
  const body = h('div', { style: { maxWidth: '920px', margin: '0 auto', width: '100%' } });
  panel.append(
    h(
      'div',
      { class: 'scroll-pad' },
      h('div', { style: { maxWidth: '920px', margin: '0 auto 16px' } }, h('div', { style: { font: '700 22px var(--display)' }, text: t('Export & Import') }), h('div', { class: 'faint', html: `${TYPE_LABEL[type]} · ${esc(a.conn.name)}${type !== 'sqlite' ? ' / ' + esc(a.ns) : ''}` }), h('div', { style: { marginTop: '14px' } }, seg)),
      body,
    ),
  );

  // ---- export SQL
  {
    const picks = new Map(tables().map((t) => [t, true]));
    const list = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '200px', overflow: 'auto' } });
    const renderList = () => {
      list.innerHTML = '';
      for (const [t, on] of picks) list.append(h('div', { class: 'chip', style: { height: '28px' } }, checkbox(t, on, (v) => picks.set(t, v))));
    };
    renderList();
    const structure = toggle(t('Structure (CREATE TABLE, indexes, relations)'), true);
    const data = toggle(t('Data (INSERT)'), true);
    const drop = toggle(t('Include DROP TABLE IF EXISTS'), true);
    const views = toggle(t('Include views'), true);
    const dialect = select([{ value: '', label: t('Same ({engine})', { engine: TYPE_LABEL[type] }) }, { value: 'mysql', label: 'MySQL / MariaDB' }, { value: 'postgres', label: 'PostgreSQL' }, { value: 'sqlite', label: 'SQLite' }], '');
    const prog = jobProgress();
    const go = h('button', { class: 'btn primary', html: icon('file-down') + `<span>${t('Create SQL file')}</span>` });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const chosen = [...picks].filter(([, v]) => v).map(([t]) => t);
        const job = await api('POST', '/api/jobs/dump', { connId: a.conn.id, ns: a.ns, tables: chosen.length === picks.size ? null : chosen, structure: structure.input.checked, data: data.input.checked, dropTable: drop.input.checked, views: views.input.checked, dialect: dialect.value || null });
        const j = await watchJob(job, prog.update);
        if (j.status === 'done') {
          toast(`${plural(j.result.tables, '{n} table', '{n} tables')} · ${plural(j.result.rows, '{n} row', '{n} rows')}`, 'ok', { title: t('Dump ready') });
          download(j.download);
        } else toast(j.error, 'err', { title: t('Export failed') });
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        go.disabled = false;
      }
    };
    panes['export-sql'] = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title', html: icon('file-down') + t('SQL dump') }),
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'section-label', text: t('Tables') }), h('span', { class: 'spacer' }), h('button', { class: 'btn xs', text: t('All'), onclick: () => (picks.forEach((_, k) => picks.set(k, true)), renderList()) }), h('button', { class: 'btn xs', text: t('None'), onclick: () => (picks.forEach((_, k) => picks.set(k, false)), renderList()) })),
      list,
      h('div', { class: 'form-grid', style: { marginTop: '16px' } }, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, structure, data, drop, views), field(t('Output SQL dialect'), dialect, t('Pick another engine to move a database between MySQL ↔ PostgreSQL ↔ SQLite.'))),
      h('div', { class: 'row', style: { marginTop: '16px' } }, h('span', { class: 'spacer' }), go),
      prog,
    );
  }

  // ---- export data
  {
    const tSel = select(tables(), table || tables()[0]);
    let format = 'csv';
    const delim = select([{ value: ',', label: t('Comma ( , )') }, { value: ';', label: t('Semicolon ( ; ) — Excel (Indonesian locale)') }, { value: '\t', label: t('Tab') }], ',');
    const delimField = field(t('Delimiter'), delim);
    const fmt = segmented([{ value: 'xlsx', label: 'Excel', icon: 'sheet' }, { value: 'csv', label: 'CSV', icon: 'file-spreadsheet' }, { value: 'json', label: 'JSON', icon: 'braces' }, { value: 'sql', label: 'SQL INSERT', icon: 'file-code-2' }], 'csv', (v) => ((format = v), (delimField.hidden = v !== 'csv')));
    const prog = jobProgress();
    const go = h('button', { class: 'btn primary', html: icon('download') + `<span>${t('Export')}</span>` });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const job =
          format === 'sql'
            ? await api('POST', '/api/jobs/dump', { connId: a.conn.id, ns: a.ns, tables: [tSel.value], structure: true, data: true, dropTable: false, views: false })
            : await api('POST', '/api/jobs/export-table', { connId: a.conn.id, ns: a.ns, table: tSel.value, format, delimiter: delim.value });
        const j = await watchJob(job, prog.update);
        if (j.status === 'done') {
          toast(plural(j.result.rows, '{n} row', '{n} rows'), 'ok', { title: t('Export complete') });
          download(j.download);
        } else toast(j.error, 'err', { title: t('Export failed') });
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        go.disabled = false;
      }
    };
    panes['export-data'] = h('div', { class: 'card' }, h('div', { class: 'card-title', html: icon('sheet') + t('Export an entire table') }), h('div', { class: 'form-grid' }, field(t('Table'), tSel), field(t('Format'), fmt), delimField), h('div', { class: 'row', style: { marginTop: '16px' } }, h('span', { class: 'spacer' }), go), prog);
    panes['export-data'].setTable = (t) => t && (tSel.value = t);
  }

  // ---- import SQL
  {
    let file = null;
    const cont = toggle(t('Continue when a statement fails'), false);
    const prog = jobProgress();
    const errors = h('div');
    const go = h('button', { class: 'btn primary', html: icon('file-up') + `<span>${t('Run import')}</span>`, disabled: true });
    const dz = dropzone('.sql,.txt', t('.sql file'), (f) => {
      file = f;
      go.disabled = false;
    });
    go.onclick = async () => {
      if (!file) return;
      go.disabled = true;
      errors.innerHTML = '';
      try {
        const text = await file.text();
        const job = await api('POST', `/api/jobs/import-sql${qs({ connId: a.conn.id, ns: type === 'sqlite' ? '' : a.ns, continueOnError: cont.input.checked ? '1' : '' })}`, text, { text: true });
        const j = await watchJob(job, prog.update);
        const errs = j.result?.errors || [];
        if (j.status === 'done') toast(t('{ok} of {total} statements succeeded', { ok: fmtNum(j.result.ok), total: fmtNum(j.result.statements) }), errs.length ? 'info' : 'ok', { title: t('Import complete') });
        else toast(j.error, 'err', { title: t('Import stopped') });
        if (errs.length) errors.append(h('div', { class: 'log', style: { marginTop: '12px' }, html: errs.slice(0, 100).map((e) => `<div class="error">#${e.index}: ${esc(e.error)}</div><div class="t">${esc(e.sql)}</div>`).join('') }));
        app.refreshNamespaces();
        app.loadTree();
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        go.disabled = false;
      }
    };
    panes['import-sql'] = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title', html: icon('file-up') + t('Import an SQL file') }),
      h('div', { class: 'notice info', style: { marginBottom: '14px' }, html: `${icon('info')}<div>${t('Runs against <b>{target}</b>, one statement at a time. Supports <span class="mono">DELIMITER</span> (MySQL), <span class="mono">$$</span> blocks (PostgreSQL) and SQLite triggers.', { target: `${esc(a.conn.name)}${type !== 'sqlite' ? ' / ' + esc(a.ns) : ''}` })}</div>` }),
      dz,
      h('div', { class: 'row', style: { marginTop: '14px' } }, cont, h('span', { class: 'spacer' }), go),
      prog,
      errors,
    );
  }

  // ---- import CSV
  {
    const tSel = select(tables(), table || tables()[0]);
    const header = toggle(t('First row contains column names'), true, () => reparse());
    const emptyNull = toggle(t('Empty cells → NULL'), true);
    const delim = select([{ value: 'auto', label: t('Auto-detect') }, { value: ',', label: t('Comma') }, { value: ';', label: t('Semicolon') }, { value: '\t', label: t('Tab') }, { value: '|', label: t('Pipe |') }], 'auto');
    const mapBox = h('div');
    const previewBox = h('div', { class: 'grid-wrap', style: { maxHeight: '240px', border: '1px solid var(--line)', borderRadius: '10px' } });
    const prog = jobProgress();
    const go = h('button', { class: 'btn primary', html: icon('table-properties') + `<span>${t('Import into table')}</span>`, disabled: true });
    let text = '';
    let parsed = null;
    let mapping = [];
    const dz = dropzone('.csv,.tsv,.txt', t('CSV file'), async (f) => {
      text = await f.text();
      reparse();
    });
    delim.onchange = () => reparse();
    tSel.onchange = () => reparse();
    function reparse() {
      if (!text) return;
      parsed = parseCSV(text, delim.value);
      const cols = state.columns[tSel.value] || [];
      const head = header.input.checked ? parsed.rows[0] : parsed.rows[0].map((_, i) => t('column {n}', { n: i + 1 }));
      const dataRows = header.input.checked ? parsed.rows.slice(1) : parsed.rows;
      mapping = head.map((hd) => cols.find((c) => c.toLowerCase() === String(hd).trim().toLowerCase()) || '');
      mapBox.innerHTML = '';
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' } });
      head.forEach((hd, i) => {
        const s = select([{ value: '', label: t('— skip —') }, ...cols.map((c) => ({ value: c, label: c }))], mapping[i]);
        s.classList.add('sm');
        s.onchange = () => (mapping[i] = s.value);
        grid.append(h('div', { class: 'field' }, h('label', { class: 'mono', text: `${hd}  →` }), s));
      });
      mapBox.append(h('div', { class: 'section-label', style: { margin: '14px 0 8px' }, text: t('Column mapping · {rows} · delimiter "{delimiter}"', { rows: plural(dataRows.length, '{n} row', '{n} rows'), delimiter: parsed.delimiter === '\t' ? t('tab') : parsed.delimiter }) }), grid);
      renderGrid(previewBox, { columns: head, rows: dataRows.slice(0, 50), animate: true });
      go.disabled = !dataRows.length;
    }
    go.onclick = async () => {
      const head = header.input.checked ? parsed.rows[0] : parsed.rows[0];
      const dataRows = header.input.checked ? parsed.rows.slice(1) : parsed.rows;
      const idx = mapping.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) return toast(t('Map at least one column'), 'err');
      const columns = idx.map((i) => mapping[i]);
      void head;
      go.disabled = true;
      let done = 0;
      try {
        for (let i = 0; i < dataRows.length; i += 1000) {
          const chunk = dataRows.slice(i, i + 1000).map((r) => idx.map((k) => (emptyNull.input.checked && (r[k] === undefined || r[k] === '') ? null : (r[k] ?? null))));
          await api('POST', `/api/c/${a.conn.id}/bulk-insert`, { ns: a.ns, table: tSel.value, columns, rows: chunk });
          done += chunk.length;
          prog.update({ progress: done / dataRows.length, phase: t('{done} / {total} rows', { done: fmtNum(done), total: fmtNum(dataRows.length) }), status: done === dataRows.length ? 'done' : 'running' });
        }
        toast(plural(done, '{n} row inserted into {table}', '{n} rows inserted into {table}', { table: tSel.value }), 'ok', { title: t('CSV import complete') });
        app.loadTree();
      } catch (e) {
        prog.update({ progress: done / dataRows.length, phase: plural(done, 'Stopped after {n} row: {error}', 'Stopped after {n} rows: {error}', { error: e.message }), status: 'error' });
        toast(e.message, 'err', { title: t('Import stopped at row ~{n}', { n: fmtNum(done + 1) }) });
      } finally {
        go.disabled = false;
      }
    };
    panes['import-csv'] = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title', html: icon('table-properties') + t('Import CSV into a table') }),
      h('div', { class: 'form-grid', style: { marginBottom: '14px' } }, field(t('Target table'), tSel), field(t('Delimiter'), delim), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, header, emptyNull)),
      dz,
      mapBox,
      h('div', { style: { marginTop: '12px' } }, previewBox),
      h('div', { class: 'notice info', style: { marginTop: '12px' }, html: `${icon('shield-check')}<div>${t('Every 1,000 rows are inserted in a single transaction.')}</div>` }),
      h('div', { class: 'row', style: { marginTop: '14px' } }, h('span', { class: 'spacer' }), go),
      prog,
    );
    panes['import-csv'].setTable = (t) => t && ((tSel.value = t), reparse());
  }

  function show(v, t) {
    body.innerHTML = '';
    const p = panes[v];
    p.style.animation = 'fx-in .4s var(--ease) both';
    body.append(p);
    p.setTable?.(t);
    if (seg.value !== v) seg.set(v);
  }
  const tab = { kind: 'transfer', icon: 'arrow-down-up', title: t('Export / Import'), panel, connId: a.conn.id, ns: a.ns, show: (v, t) => show(v, t) };
  addTab(tab);
  show(which, table);
}

Object.assign(app, { openTransfer });
