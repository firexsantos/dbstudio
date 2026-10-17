// Data grid shared by query results, table data, structure and server views.
import { esc, icon, valStr, copyText, showMenu, clamp, fmtNum, DEFAULT } from './core.js';
import { motionOK } from './fx.js';

function shortType(t) {
  return String(t || '').replace(/ unsigned/i, ' uns').replace(/character varying/i, 'varchar').replace(/timestamp without time zone/i, 'timestamp').slice(0, 24);
}

function cellHtml(v, extra = '') {
  if (v === DEFAULT) return `<td class="${extra}"><span class="null">DEFAULT</span></td>`;
  if (v === null || v === undefined) return `<td class="${extra}"><span class="null">NULL</span></td>`;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const num = typeof v === 'number' || (typeof v === 'string' && s.length < 20 && /^-?\d+(\.\d+)?$/.test(s));
  const shown = s.length > 300 ? s.slice(0, 300) + '…' : s;
  const title = s.length > 40 ? ` title="${esc(s.slice(0, 2000))}"` : '';
  return `<td class="${num ? 'num ' : ''}${extra}"${title}>${esc(shown)}</td>`;
}

export function cmpValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return valStr(a).localeCompare(valStr(b), undefined, { numeric: true });
}
export function nextSort(s, i) {
  if (!s || s.col !== i) return { col: i, dir: 'asc' };
  return s.dir === 'asc' ? { col: i, dir: 'desc' } : null;
}

/**
 * o: { columns, rows | count+getValue, meta?, sort?, onSort?, limit?, onMore?, editable?(r,c), onEdit?(r,c,v),
 *      cellClass?(r,c), rowClass?(r), rowLabel?(r), selected?(Set), onRowNumClick?(r,e), onCellMenu?(e,r,c),
 *      onDeleteKey?, rerender?, animate?, flash?(Set) }
 */
export function renderGrid(wrap, o) {
  const count = o.count ?? o.rows.length;
  const getValue = o.getValue || ((r, c) => o.rows[r][c]);
  const shown = Math.min(count, o.limit ?? count);
  const ncols = o.columns.length;
  const { scrollTop, scrollLeft } = wrap;
  const animate = o.animate && motionOK();

  const head = o.columns
    .map((c, i) => {
      const m = o.meta?.[i];
      const arrow = o.sort?.col === i ? `<span class="arrow">${icon(o.sort.dir === 'asc' ? 'arrow-up' : 'arrow-down')}</span>` : '';
      const title = m ? `${c} : ${m.type}${m.nullable === false ? ' NOT NULL' : ''}${m.pk ? ' (PRIMARY KEY)' : ''}` : c;
      return `<th data-i="${i}" title="${esc(title)}">${m?.pk ? `<span class="pk">${icon('key-round')}</span>` : ''}${esc(c)}${
        m?.type ? `<span class="ctype">${esc(shortType(m.type))}</span>` : ''
      }${arrow}</th>`;
    })
    .join('');

  const body = [];
  for (let r = 0; r < shown; r++) {
    let cls = (o.rowClass?.(r) || '') + (o.selected?.has(r) ? ' selected' : '') + (o.flash?.has(r) ? ' flash-ok' : '');
    let style = '';
    if (animate && r < 40) {
      cls += ' cascade';
      style = ` style="--i:${r}"`;
    }
    body.push(`<tr class="${cls}"${style}><td class="rownum">${o.rowLabel ? o.rowLabel(r) : r + 1}</td>`);
    for (let c = 0; c < ncols; c++) body.push(cellHtml(getValue(r, c), o.cellClass?.(r, c) || ''));
    body.push('</tr>');
  }

  const table = document.createElement('table');
  table.className = 'grid';
  table.innerHTML = `<thead><tr><th class="rownum">#</th>${head}</tr></thead><tbody>${body.join('')}</tbody>`;
  const tbody = table.tBodies[0];
  wrap.innerHTML = '';
  wrap.append(table);
  if (shown < count) {
    const more = document.createElement('div');
    more.className = 'grid-more';
    more.innerHTML = `Menampilkan ${fmtNum(shown)} dari ${fmtNum(count)} baris · <button class="btn sm">${icon('chevrons-down')}<span>Tampilkan lebih banyak</span></button>`;
    more.querySelector('button').onclick = () => o.onMore?.();
    wrap.append(more);
  }
  wrap.scrollTop = scrollTop;
  wrap.scrollLeft = scrollLeft;
  wrap.tabIndex = 0;

  const tdAt = (r, c) => tbody.rows[r]?.cells[c + 1];
  function setActive(r, c, scroll = true) {
    wrap.querySelector('td.cell-active')?.classList.remove('cell-active');
    const td = tdAt(r, c);
    if (!td) return;
    td.classList.add('cell-active');
    wrap._active = { r, c };
    if (scroll) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  if (wrap._active && wrap._active.r < shown && wrap._active.c < ncols) setActive(wrap._active.r, wrap._active.c, false);
  else wrap._active = null;

  function edit(r, c) {
    const td = tdAt(r, c);
    if (!td || !o.editable?.(r, c)) return;
    setActive(r, c);
    const cur = getValue(r, c);
    const curStr = cur == null || cur === DEFAULT ? '' : valStr(cur);
    const input = document.createElement('input');
    input.value = curStr;
    input.placeholder = cur === DEFAULT ? 'DEFAULT' : cur == null ? 'NULL' : '';
    td.classList.add('editing');
    td.textContent = '';
    td.append(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit && input.value !== curStr) o.onEdit(r, c, input.value);
      else o.rerender?.();
      wrap.focus({ preventScroll: true });
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true);
        setTimeout(() => o.editNext?.(r, c + (e.shiftKey ? -1 : 1)), 0);
      }
    };
    input.onblur = () => finish(true);
  }

  table.onclick = (e) => {
    const th = e.target.closest('th[data-i]');
    if (th) return o.onSort?.(Number(th.dataset.i));
    const td = e.target.closest('td');
    if (!td || td.classList.contains('editing')) return;
    const r = td.parentElement.sectionRowIndex;
    if (td.classList.contains('rownum')) return o.onRowNumClick?.(r, e);
    setActive(r, td.cellIndex - 1, false);
  };
  table.ondblclick = (e) => {
    const td = e.target.closest('td');
    if (!td || td.classList.contains('rownum')) return;
    edit(td.parentElement.sectionRowIndex, td.cellIndex - 1);
  };
  table.oncontextmenu = (e) => {
    const td = e.target.closest('td');
    if (!td || td.classList.contains('rownum')) return;
    const r = td.parentElement.sectionRowIndex;
    const c = td.cellIndex - 1;
    setActive(r, c, false);
    if (o.onCellMenu) return o.onCellMenu(e, r, c);
    showMenu(e, [
      { label: 'Salin nilai', icon: 'copy', action: () => copyText(valStr(getValue(r, c))) },
      {
        label: 'Salin baris (JSON)',
        icon: 'braces',
        action: () => copyText(JSON.stringify(Object.fromEntries(o.columns.map((col, i) => [col, getValue(r, i)])), null, 2)),
      },
      { label: 'Salin kolom', icon: 'columns-3', action: () => copyText(Array.from({ length: shown }, (_, i) => valStr(getValue(i, c))).join('\n')) },
    ]);
  };
  wrap.onkeydown = (e) => {
    if (e.target !== wrap) return;
    const a = wrap._active;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && a) {
      e.preventDefault();
      return copyText(valStr(getValue(a.r, a.c)));
    }
    if (e.key === 'Delete' && o.onDeleteKey) {
      e.preventDefault();
      return o.onDeleteKey();
    }
    if (!a) return;
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      setActive(clamp(a.r + dr, 0, shown - 1), clamp(a.c + dc, 0, ncols - 1));
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      edit(a.r, a.c);
    }
  };
  return { edit, setActive };
}

export function toCSV(columns, rows) {
  const cell = (v) => {
    if (v == null || v === DEFAULT) return '';
    const s = valStr(v);
    return /[",\n\r;]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  return '﻿' + [columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
