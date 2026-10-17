// Export / import: SQL dump, full-table CSV/JSON, SQL script import, CSV import with column mapping.
import { h, icon, esc, api, qs, state, app, toast, watchJob, download, segmented, toggle, checkbox, select, field, fmtNum, fmtBytes, TYPE_LABEL } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { renderGrid } from './grid.js';

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
  const z = h('div', { class: 'dropzone', tabindex: 0 }, h('div', { html: icon('cloud-upload') }), h('div', { html: `<b>${label}</b> — seret ke sini atau klik untuk memilih` }), info, input);
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
  if (!a) return toast('Hubungkan ke database dulu', 'err');
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
      { value: 'export-sql', label: 'Export SQL', icon: 'file-down' },
      { value: 'export-data', label: 'Export data', icon: 'sheet' },
      { value: 'import-sql', label: 'Import SQL', icon: 'file-up' },
      { value: 'import-csv', label: 'Import CSV', icon: 'table-properties' },
    ],
    which,
    (v) => show(v),
  );
  const body = h('div', { style: { maxWidth: '920px', margin: '0 auto', width: '100%' } });
  panel.append(
    h(
      'div',
      { class: 'scroll-pad' },
      h('div', { style: { maxWidth: '920px', margin: '0 auto 16px' } }, h('div', { style: { font: '700 22px var(--display)' }, text: 'Export & Import' }), h('div', { class: 'faint', html: `${TYPE_LABEL[type]} · ${esc(a.conn.name)}${type !== 'sqlite' ? ' / ' + esc(a.ns) : ''}` }), h('div', { style: { marginTop: '14px' } }, seg)),
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
    const structure = toggle('Struktur (CREATE TABLE, index, relasi)', true);
    const data = toggle('Data (INSERT)', true);
    const drop = toggle('Sertakan DROP TABLE IF EXISTS', true);
    const views = toggle('Sertakan view', true);
    const dialect = select([{ value: '', label: `Sama (${TYPE_LABEL[type]})` }, { value: 'mysql', label: 'MySQL / MariaDB' }, { value: 'postgres', label: 'PostgreSQL' }, { value: 'sqlite', label: 'SQLite' }], '');
    const prog = jobProgress();
    const go = h('button', { class: 'btn primary', html: icon('file-down') + '<span>Buat file SQL</span>' });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const chosen = [...picks].filter(([, v]) => v).map(([t]) => t);
        const job = await api('POST', '/api/jobs/dump', { connId: a.conn.id, ns: a.ns, tables: chosen.length === picks.size ? null : chosen, structure: structure.input.checked, data: data.input.checked, dropTable: drop.input.checked, views: views.input.checked, dialect: dialect.value || null });
        const j = await watchJob(job, prog.update);
        if (j.status === 'done') {
          toast(`${j.result.tables} tabel · ${fmtNum(j.result.rows)} baris`, 'ok', { title: 'Dump siap' });
          download(j.download);
        } else toast(j.error, 'err', { title: 'Export gagal' });
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        go.disabled = false;
      }
    };
    panes['export-sql'] = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title', html: icon('file-down') + 'Dump SQL' }),
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'section-label', text: 'Tabel' }), h('span', { class: 'spacer' }), h('button', { class: 'btn xs', text: 'Semua', onclick: () => (picks.forEach((_, k) => picks.set(k, true)), renderList()) }), h('button', { class: 'btn xs', text: 'Tidak ada', onclick: () => (picks.forEach((_, k) => picks.set(k, false)), renderList()) })),
      list,
      h('div', { class: 'form-grid', style: { marginTop: '16px' } }, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, structure, data, drop, views), field('Dialek SQL hasil', dialect, 'Pilih engine lain untuk memindahkan database antar MySQL ↔ PostgreSQL ↔ SQLite.')),
      h('div', { class: 'row', style: { marginTop: '16px' } }, h('span', { class: 'spacer' }), go),
      prog,
    );
  }

  // ---- export data
  {
    const tSel = select(tables(), table || tables()[0]);
    let format = 'csv';
    const delim = select([{ value: ',', label: 'Koma ( , )' }, { value: ';', label: 'Titik koma ( ; ) — Excel Indonesia' }, { value: '\t', label: 'Tab' }], ',');
    const delimField = field('Pemisah', delim);
    const fmt = segmented([{ value: 'csv', label: 'CSV', icon: 'file-spreadsheet' }, { value: 'json', label: 'JSON', icon: 'braces' }, { value: 'sql', label: 'SQL INSERT', icon: 'file-code-2' }], 'csv', (v) => ((format = v), (delimField.hidden = v !== 'csv')));
    const prog = jobProgress();
    const go = h('button', { class: 'btn primary', html: icon('download') + '<span>Export</span>' });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const job =
          format === 'sql'
            ? await api('POST', '/api/jobs/dump', { connId: a.conn.id, ns: a.ns, tables: [tSel.value], structure: true, data: true, dropTable: false, views: false })
            : await api('POST', '/api/jobs/export-table', { connId: a.conn.id, ns: a.ns, table: tSel.value, format, delimiter: delim.value });
        const j = await watchJob(job, prog.update);
        if (j.status === 'done') {
          toast(`${fmtNum(j.result.rows)} baris`, 'ok', { title: 'Export selesai' });
          download(j.download);
        } else toast(j.error, 'err', { title: 'Export gagal' });
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        go.disabled = false;
      }
    };
    panes['export-data'] = h('div', { class: 'card' }, h('div', { class: 'card-title', html: icon('sheet') + 'Export seluruh isi tabel' }), h('div', { class: 'form-grid' }, field('Tabel', tSel), field('Format', fmt), delimField), h('div', { class: 'row', style: { marginTop: '16px' } }, h('span', { class: 'spacer' }), go), prog);
    panes['export-data'].setTable = (t) => t && (tSel.value = t);
  }

  // ---- import SQL
  {
    let file = null;
    const cont = toggle('Lanjutkan walau ada statement yang gagal', false);
    const prog = jobProgress();
    const errors = h('div');
    const go = h('button', { class: 'btn primary', html: icon('file-up') + '<span>Jalankan import</span>', disabled: true });
    const dz = dropzone('.sql,.txt', 'File .sql', (f) => {
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
        if (j.status === 'done') toast(`${fmtNum(j.result.ok)} dari ${fmtNum(j.result.statements)} statement berhasil`, errs.length ? 'info' : 'ok', { title: 'Import selesai' });
        else toast(j.error, 'err', { title: 'Import berhenti' });
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
      h('div', { class: 'card-title', html: icon('file-up') + 'Import file SQL' }),
      h('div', { class: 'notice info', style: { marginBottom: '14px' }, html: `${icon('info')}<div>Dijalankan ke <b>${esc(a.conn.name)}${type !== 'sqlite' ? ' / ' + esc(a.ns) : ''}</b>, statement demi statement. Mendukung <span class="mono">DELIMITER</span> (MySQL), blok <span class="mono">$$</span> (PostgreSQL) dan trigger SQLite.</div>` }),
      dz,
      h('div', { class: 'row', style: { marginTop: '14px' } }, cont, h('span', { class: 'spacer' }), go),
      prog,
      errors,
    );
  }

  // ---- import CSV
  {
    const tSel = select(tables(), table || tables()[0]);
    const header = toggle('Baris pertama adalah nama kolom', true, () => reparse());
    const emptyNull = toggle('Sel kosong → NULL', true);
    const delim = select([{ value: 'auto', label: 'Deteksi otomatis' }, { value: ',', label: 'Koma' }, { value: ';', label: 'Titik koma' }, { value: '\t', label: 'Tab' }, { value: '|', label: 'Pipa |' }], 'auto');
    const mapBox = h('div');
    const previewBox = h('div', { class: 'grid-wrap', style: { maxHeight: '240px', border: '1px solid var(--line)', borderRadius: '10px' } });
    const prog = jobProgress();
    const go = h('button', { class: 'btn primary', html: icon('table-properties') + '<span>Import ke tabel</span>', disabled: true });
    let text = '';
    let parsed = null;
    let mapping = [];
    const dz = dropzone('.csv,.tsv,.txt', 'File CSV', async (f) => {
      text = await f.text();
      reparse();
    });
    delim.onchange = () => reparse();
    tSel.onchange = () => reparse();
    function reparse() {
      if (!text) return;
      parsed = parseCSV(text, delim.value);
      const cols = state.columns[tSel.value] || [];
      const head = header.input.checked ? parsed.rows[0] : parsed.rows[0].map((_, i) => `kolom ${i + 1}`);
      const dataRows = header.input.checked ? parsed.rows.slice(1) : parsed.rows;
      mapping = head.map((hd) => cols.find((c) => c.toLowerCase() === String(hd).trim().toLowerCase()) || '');
      mapBox.innerHTML = '';
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' } });
      head.forEach((hd, i) => {
        const s = select([{ value: '', label: '— lewati —' }, ...cols.map((c) => ({ value: c, label: c }))], mapping[i]);
        s.classList.add('sm');
        s.onchange = () => (mapping[i] = s.value);
        grid.append(h('div', { class: 'field' }, h('label', { class: 'mono', text: `${hd}  →` }), s));
      });
      mapBox.append(h('div', { class: 'section-label', style: { margin: '14px 0 8px' }, text: `Pemetaan kolom · ${fmtNum(dataRows.length)} baris · pemisah "${parsed.delimiter === '\t' ? 'tab' : parsed.delimiter}"` }), grid);
      renderGrid(previewBox, { columns: head, rows: dataRows.slice(0, 50), animate: true });
      go.disabled = !dataRows.length;
    }
    go.onclick = async () => {
      const head = header.input.checked ? parsed.rows[0] : parsed.rows[0];
      const dataRows = header.input.checked ? parsed.rows.slice(1) : parsed.rows;
      const idx = mapping.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) return toast('Petakan minimal satu kolom', 'err');
      const columns = idx.map((i) => mapping[i]);
      void head;
      go.disabled = true;
      let done = 0;
      try {
        for (let i = 0; i < dataRows.length; i += 1000) {
          const chunk = dataRows.slice(i, i + 1000).map((r) => idx.map((k) => (emptyNull.input.checked && (r[k] === undefined || r[k] === '') ? null : (r[k] ?? null))));
          await api('POST', `/api/c/${a.conn.id}/bulk-insert`, { ns: a.ns, table: tSel.value, columns, rows: chunk });
          done += chunk.length;
          prog.update({ progress: done / dataRows.length, phase: `${fmtNum(done)} / ${fmtNum(dataRows.length)} baris`, status: done === dataRows.length ? 'done' : 'running' });
        }
        toast(`${fmtNum(done)} baris masuk ke ${tSel.value}`, 'ok', { title: 'Import CSV selesai' });
        app.loadTree();
      } catch (e) {
        prog.update({ progress: done / dataRows.length, phase: `Berhenti setelah ${fmtNum(done)} baris: ${e.message}`, status: 'error' });
        toast(e.message, 'err', { title: `Import berhenti di baris ~${fmtNum(done + 1)}` });
      } finally {
        go.disabled = false;
      }
    };
    panes['import-csv'] = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-title', html: icon('table-properties') + 'Import CSV ke tabel' }),
      h('div', { class: 'form-grid', style: { marginBottom: '14px' } }, field('Tabel tujuan', tSel), field('Pemisah', delim), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, header, emptyNull)),
      dz,
      mapBox,
      h('div', { style: { marginTop: '12px' } }, previewBox),
      h('div', { class: 'notice info', style: { marginTop: '12px' }, html: `${icon('shield-check')}<div>Setiap 1.000 baris dimasukkan dalam satu transaksi.</div>` }),
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
  const tab = { kind: 'transfer', icon: 'arrow-down-up', title: 'Export / Import', panel, connId: a.conn.id, ns: a.ns, show: (v, t) => show(v, t) };
  addTab(tab);
  show(which, table);
}

Object.assign(app, { openTransfer });
