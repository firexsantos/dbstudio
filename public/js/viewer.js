// Value viewer (JSON tree, image BLOB, long text, hex) and the record form view of table tabs.
import { h, icon, esc, modal, copyText, valStr, DEFAULT, fmtBytes } from './core.js';
import { t, plural } from './i18n.js';

const MAGIC = [
  ['89504e47', 'image/png'],
  ['ffd8ff', 'image/jpeg'],
  ['47494638', 'image/gif'],
  ['52494646', 'image/webp'],
  ['3c737667', 'image/svg+xml'],
  ['25504446', 'application/pdf'],
];

function hexOf(v) {
  if (typeof v === 'string' && /^0x[0-9a-f]*$/i.test(v)) return v.slice(2).toLowerCase();
  return null;
}
export function detect(v) {
  if (v == null || v === DEFAULT) return { kind: 'null' };
  const hex = hexOf(v);
  if (hex) {
    const mime = MAGIC.find(([m]) => hex.startsWith(m))?.[1];
    return { kind: mime?.startsWith('image/') ? 'image' : 'binary', mime, hex, bytes: hex.length / 2 };
  }
  if (typeof v === 'object') return { kind: 'json', data: v };
  const s = String(v);
  if (/^\s*[[{]/.test(s)) {
    try {
      return { kind: 'json', data: JSON.parse(s) };
    } catch {
      /* not JSON */
    }
  }
  return { kind: s.length > 120 || s.includes('\n') ? 'text' : 'short', text: s };
}

function jsonTree(v, depth = 0) {
  if (v === null) return '<span class="j-null">null</span>';
  if (typeof v === 'string') return `<span class="j-str">"${esc(v)}"</span>`;
  if (typeof v === 'number') return `<span class="j-num">${v}</span>`;
  if (typeof v === 'boolean') return `<span class="j-bool">${v}</span>`;
  const arr = Array.isArray(v);
  const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
  if (!entries.length) return arr ? '[]' : '{}';
  const open = depth < 2 ? ' open' : '';
  return `<details${open}><summary>${arr ? `[${entries.length}]` : `{${entries.length}}`}</summary><div class="j-body">${entries
    .map(([k, x]) => `<div>${arr ? '' : `<span class="j-key">${esc(k)}</span>: `}${jsonTree(x, depth + 1)}</div>`)
    .join('')}</div></details>`;
}

const hexDump = (hex, max = 512) => {
  const out = [];
  for (let i = 0; i < Math.min(hex.length / 2, max); i += 16) {
    const bytes = hex.slice(i * 2, i * 2 + 32).match(/../g) || [];
    const ascii = bytes.map((b) => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '·'; }).join('');
    out.push(`${i.toString(16).padStart(6, '0')}  ${bytes.join(' ').padEnd(47)}  ${esc(ascii)}`);
  }
  return out.join('\n');
};

/** opts: { value, column, type, editable, onSave(newString|null) } */
export function openValueViewer({ value, column, type = '', editable = false, onSave }) {
  const d = detect(value);
  const body = h('div', { class: 'vv' });
  const info = [];
  let editor = null;
  if (d.kind === 'null') body.append(h('div', { class: 'empty', html: '<span class="null">NULL</span>' }));
  else if (d.kind === 'image') {
    const url = `data:${d.mime};base64,${btoa(d.hex.match(/../g).map((b) => String.fromCharCode(parseInt(b, 16))).join(''))}`;
    body.append(h('div', { class: 'vv-img' }, h('img', { src: url, alt: column })));
    info.push(d.mime, fmtBytes(d.bytes));
  } else if (d.kind === 'binary') {
    body.append(h('pre', { class: 'vv-hex', html: hexDump(d.hex) }));
    info.push(d.mime || t('binary'), fmtBytes(d.bytes));
  } else if (d.kind === 'json') {
    const tree = h('div', { class: 'vv-json', html: jsonTree(d.data) });
    editor = h('textarea', { class: 'textarea vv-text', rows: 14, spellcheck: 'false' });
    editor.value = JSON.stringify(d.data, null, 2);
    editor.hidden = true;
    const toggleBtn = h('button', { class: 'btn xs', html: icon('code-xml') + `<span>${t('Text')}</span>` });
    toggleBtn.onclick = () => {
      editor.hidden = !editor.hidden;
      tree.hidden = !editor.hidden;
      toggleBtn.querySelector('span').textContent = editor.hidden ? t('Text') : t('Tree');
    };
    body.append(h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, toggleBtn), tree, editor);
    info.push('JSON');
  } else {
    editor = h('textarea', { class: 'textarea vv-text', rows: d.kind === 'short' ? 4 : 14, spellcheck: 'false' });
    editor.value = d.text;
    editor.readOnly = !editable;
    body.append(editor);
    const lines = d.text.split('\n').length;
    info.push(plural(d.text.length, '{n} character', '{n} characters'), plural(lines, '{n} line', '{n} lines'));
  }
  if (editor && editable) editor.readOnly = false;
  const m = modal({
    title: column,
    sub: [type, ...info].filter(Boolean).join(' · '),
    icon: { image: 'image', binary: 'binary', json: 'braces', null: 'circle-slash' }[d.kind] || 'text',
    size: 'wide',
    body,
    actions: [
      h('button', { class: 'btn ghost sm', html: icon('copy') + `<span>${t('Copy')}</span>`, onclick: () => copyText(editor ? editor.value : valStr(value)) }),
      'spacer',
      editable && onSave ? h('button', { class: 'btn ghost sm', html: icon('circle-slash') + '<span>Set NULL</span>', onclick: () => (onSave(null), m.close()) }) : null,
      { label: t('Close') },
      editable && onSave && editor
        ? {
            label: t('Save to cell'),
            kind: 'primary',
            icon: 'check',
            onClick: () => {
              let v = editor.value;
              if (d.kind === 'json') v = JSON.stringify(JSON.parse(v));
              onSave(v);
            },
          }
        : null,
    ].filter(Boolean),
  });
}

/**
 * Record form view. opts: { columns, meta, count, row, getValue(r,c), editable(r), onEdit(r,c,v|null), fk(c) -> {table,column}|null,
 *   onOpenFk(c,v), onNav(r), rowLabel(r), rowState(r) }
 */
export function renderForm(box, o) {
  box.innerHTML = '';
  if (!o.count) {
    box.append(h('div', { class: 'empty', text: t('No rows.') }));
    return;
  }
  const r = Math.max(0, Math.min(o.count - 1, o.row));
  const editable = o.editable(r);
  const nav = h(
    'div',
    { class: 'form-nav' },
    h('button', { class: 'btn sm icon', title: t('First row'), html: icon('chevrons-left'), disabled: r === 0, onclick: () => o.onNav(0) }),
    h('button', { class: 'btn sm icon', title: t('Previous (PageUp)'), html: icon('chevron-left'), disabled: r === 0, onclick: () => o.onNav(r - 1) }),
    h('span', { class: 'form-pos', html: t('Row <b>{label}</b> · {pos} of {total}', { label: esc(o.rowLabel(r)), pos: r + 1, total: o.count }) }),
    h('button', { class: 'btn sm icon', title: t('Next (PageDown)'), html: icon('chevron-right'), disabled: r >= o.count - 1, onclick: () => o.onNav(r + 1) }),
    h('button', { class: 'btn sm icon', title: t('Last row'), html: icon('chevrons-right'), disabled: r >= o.count - 1, onclick: () => o.onNav(o.count - 1) }),
    o.rowState(r) ? h('span', { class: `chip ${o.rowState(r).cls}`, text: o.rowState(r).label }) : null,
  );
  const grid = h('div', { class: 'form-grid-rec' });
  o.columns.forEach((name, c) => {
    const m = o.meta[c] || {};
    const v = o.getValue(r, c);
    const fk = o.fk(c);
    const isNull = v == null;
    const long = v != null && (valStr(v).length > 80 || valStr(v).includes('\n') || /json|text|blob/i.test(m.type || ''));
    const input = long ? h('textarea', { class: 'textarea', rows: 3 }) : h('input', { class: 'input' });
    input.value = isNull || v === DEFAULT ? '' : valStr(v);
    input.placeholder = v === DEFAULT ? 'DEFAULT' : isNull ? 'NULL' : '';
    input.readOnly = !editable;
    input.addEventListener('change', () => o.onEdit(r, c, input.value));
    const tools = h(
      'div',
      { class: 'ff-tools' },
      editable && m.nullable !== false ? h('button', { class: 'btn ghost xs', title: 'Set NULL', text: 'NULL', onclick: () => o.onEdit(r, c, null) }) : null,
      h('button', { class: 'btn ghost xs icon', title: t('View value'), html: icon('maximize-2'), onclick: () => openValueViewer({ value: v, column: name, type: m.type, editable, onSave: (nv) => o.onEdit(r, c, nv) }) }),
      fk && v != null ? h('button', { class: 'btn ghost xs', title: t('Open {table}', { table: fk.table }), html: `${icon('arrow-up-right')}<span>${esc(fk.table)}</span>`, onclick: () => o.onOpenFk(c, v) }) : null,
    );
    grid.append(
      h(
        'div',
        { class: 'ff' + (o.dirty?.(r, c) ? ' dirty' : ''), style: { '--i': c } },
        h('label', {}, m.pk ? h('span', { class: 'pk', html: icon('key-round') }) : null, fk ? h('span', { class: 'fkm', html: icon('link-2') }) : null, h('span', { class: 'mono', text: name }), h('span', { class: 'ctype', text: m.type || '' })),
        h('div', { class: 'ff-in' }, input, tools),
      ),
    );
  });
  box.append(nav, grid);
}
