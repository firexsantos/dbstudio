// Export a result set (columns + rows) to many formats, as a download or to the clipboard.
import { h, esc, toast, showMenu, copyText, downloadText, valStr, quoteIdent, sqlLiteral, DEFAULT } from './core.js';
import { toCSV } from './grid.js';
import { t, plural, LANG } from './i18n.js';

const plain = (v) => (v == null || v === DEFAULT ? '' : valStr(v));

export const formats = {
  csv: (c, r) => toCSV(c, r),
  csvSemi: (c, r) => '﻿' + [c, ...r].map((row) => row.map((v) => { const s = plain(v); return /[";\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; }).join(';')).join('\r\n'),
  tsv: (c, r) => [c, ...r].map((row) => row.map((v) => plain(v).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n'),
  json: (c, r) => JSON.stringify(r.map((row) => Object.fromEntries(c.map((k, i) => [k, row[i] === DEFAULT ? null : row[i]]))), null, 2),
  md: (c, r) => {
    const cell = (v) => plain(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    return [`| ${c.map(cell).join(' | ')} |`, `|${c.map(() => '---').join('|')}|`, ...r.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
  },
  html: (c, r, name) =>
    `<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><title>${esc(name)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#14182e}table{border-collapse:collapse}th,td{border:1px solid #dde1ec;padding:6px 10px;text-align:left}th{background:#5b3df5;color:#fff}tr:nth-child(even) td{background:#f6f7fb}</style></head><body><h2>${esc(name)}</h2><table><thead><tr>${c
      .map((k) => `<th>${esc(k)}</th>`)
      .join('')}</tr></thead><tbody>${r.map((row) => `<tr>${row.map((v) => `<td>${esc(plain(v))}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`,
  sql: (c, r, name, type) => {
    const tbl = quoteIdent(name || t('result'), type);
    const cols = c.map((k) => quoteIdent(k, type)).join(', ');
    return r.map((row) => `INSERT INTO ${tbl} (${cols}) VALUES (${row.map((v) => (v === DEFAULT ? 'DEFAULT' : sqlLiteral(v))).join(', ')});`).join('\n');
  },
};

async function xlsx(columns, rows, name) {
  const res = await fetch('/api/xlsx', { method: 'POST', headers: { 'X-DBStudio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ columns, rows, sheet: name }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `${name}.xlsx` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** opts: { columns, rows, name, type, extra: [menu items] } */
export function exportMenu(e, { columns, rows, name = t('result'), type = 'mysql', extra = [] }) {
  const file = String(name).replace(/[^\w.-]+/g, '_') || t('result');
  const dl = (fmt, ext, mime) => () => downloadText(`${file}.${ext}`, formats[fmt](columns, rows, name, type), mime);
  const cp = (fmt, label) => async () => {
    await copyText(formats[fmt](columns, rows, name, type));
    void label;
  };
  showMenu(e, [
    { label: plural(rows.length, 'Download · {n} row', 'Download · {n} rows'), header: true },
    { label: 'Excel (.xlsx)', icon: 'sheet', action: () => xlsx(columns, rows, name).then(() => toast(t('Excel file ready'), 'ok', { timeout: 1600 }), (err) => toast(err.message, 'err')) },
    { label: t('CSV (comma)'), icon: 'file-spreadsheet', action: dl('csv', 'csv', 'text/csv') },
    { label: t('CSV (semicolon — Excel, Indonesian locale)'), icon: 'file-spreadsheet', action: dl('csvSemi', 'csv', 'text/csv') },
    { label: 'JSON', icon: 'braces', action: dl('json', 'json', 'application/json') },
    { label: 'Markdown', icon: 'file-text', action: dl('md', 'md', 'text/markdown') },
    { label: t('HTML (table)'), icon: 'globe', action: dl('html', 'html', 'text/html') },
    { label: 'SQL INSERT', icon: 'file-code-2', action: dl('sql', 'sql', 'text/plain') },
    '-',
    { label: t('Copy'), header: true },
    { label: t('Copy for Excel / Sheets (tab)'), icon: 'clipboard-paste', action: cp('tsv') },
    { label: t('Copy as Markdown'), icon: 'clipboard', action: cp('md') },
    { label: t('Copy as JSON'), icon: 'clipboard', action: cp('json') },
    ...extra,
  ]);
}
