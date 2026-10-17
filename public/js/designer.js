// Table designer: create or alter a table (columns, primary key, indexes, foreign keys) with live SQL preview.
import { h, icon, esc, api, qs, state, app, toast, debounce, createEditor, sqlPreview, select, checkbox, confirmDialog, TYPE_LABEL } from './core.js';
import { addTab, activateTab, renderTabs, findTab, closeTab } from './tabs.js';
import { invalidateSchema } from './table.js';
import { t, plural, LANG } from './i18n.js';

const TYPES = {
  mysql: ['int', 'bigint', 'smallint', 'tinyint(1)', 'decimal(10,2)', 'float', 'double', 'varchar(255)', 'char(36)', 'text', 'mediumtext', 'longtext', 'json', 'date', 'datetime', 'timestamp', 'time', 'year', 'blob', 'longblob', "enum('a','b')"],
  postgres: ['integer', 'bigint', 'smallint', 'numeric(10,2)', 'real', 'double precision', 'boolean', 'varchar(255)', 'char(10)', 'text', 'jsonb', 'json', 'uuid', 'date', 'timestamp', 'timestamptz', 'time', 'interval', 'bytea', 'inet', 'text[]'],
  sqlite: ['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB', 'VARCHAR(255)', 'BOOLEAN', 'DATE', 'DATETIME'],
};
const RULES = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
let uid = 0;

function blankModel(type) {
  const id = { mysql: 'int', postgres: 'integer', sqlite: 'INTEGER' }[type];
  const str = { mysql: 'varchar(255)', postgres: 'varchar(255)', sqlite: 'TEXT' }[type];
  const ts = { mysql: 'datetime', postgres: 'timestamp', sqlite: 'DATETIME' }[type];
  return {
    name: '',
    comment: '',
    engine: type === 'mysql' ? 'InnoDB' : null,
    columns: [
      { name: 'id', type: id, nullable: false, default: null, autoIncrement: true, comment: '' },
      { name: LANG === 'id' ? 'nama' : 'name', type: str, nullable: false, default: null, autoIncrement: false, comment: '' },
      { name: LANG === 'id' ? 'dibuat_pada' : 'created_at', type: ts, nullable: false, default: 'CURRENT_TIMESTAMP', autoIncrement: false, comment: '' },
    ],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
  };
}

export function displayDefault(d) {
  if (d == null) return '';
  const m = /^'((?:[^']|'')*)'(::[\w\s]+(\(\d+\))?)?$/.exec(String(d));
  return m ? m[1].replaceAll("''", "'") : String(d);
}
function encodeDefault(input, original) {
  if (original !== undefined && input === displayDefault(original)) return original ?? null;
  const v = input.trim();
  if (v === '' || /^null$/i.test(v)) return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(current_timestamp(\(\d*\))?|current_date|current_time|localtimestamp|true|false)$/i.test(v) || /^\w+\(.*\)$/.test(v) || /^\(.*\)$/.test(v) || /^'.*'$/.test(v)) return v;
  return `'${v.replaceAll("'", "''")}'`;
}

// Small multi-select popover.
function multiPick(anchor, options, selected, onChange) {
  document.querySelector('.multi-pop')?.remove();
  const pop = h('div', { id: 'ctx-menu', class: 'multi-pop' });
  if (!options.length) pop.append(h('div', { class: 'm-label', text: t('No columns') }));
  for (const o of options) {
    const cb = checkbox(o.label, selected.includes(o.value), (on) => {
      const next = on ? [...selected, o.value] : selected.filter((x) => x !== o.value);
      selected = options.map((x) => x.value).filter((v) => next.includes(v));
      onChange(selected);
    });
    cb.style.cssText = 'display:flex;padding:6px 10px;border-radius:8px';
    pop.append(cb);
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - 230) + 'px';
  pop.style.top = Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8) + 'px';
  const off = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.remove();
      removeEventListener('mousedown', off, true);
    }
  };
  setTimeout(() => addEventListener('mousedown', off, true));
}

export async function openDesigner(table = null) {
  const a = state.active;
  if (!a) return toast(t('Connect to a database first'), 'err');
  const existing = findTab((t) => t.kind === 'designer' && t.connId === a.conn.id && t.ns === a.ns && t.table === table && table);
  if (existing) return activateTab(existing.id);
  const type = a.conn.type;
  let model;
  try {
    model = table ? await api('GET', `/api/c/${a.conn.id}/describe${qs({ ns: a.ns, table })}`) : blankModel(type);
  } catch (e) {
    return toast(e.message, 'err');
  }

  // ---- editable state
  const cols = model.columns.map((c) => ({ ...c, _id: ++uid, origName: table ? c.name : undefined, defaultInput: displayDefault(c.default), defaultOrig: c.default, pk: model.primaryKey.includes(c.name) }));
  const idOf = (name) => cols.find((c) => c.name === name)?._id;
  const nameOf = (id) => cols.find((c) => c._id === id)?.name;
  const indexes = model.indexes.filter((i) => !i.complex).map((i) => ({ name: i.name, unique: i.unique, cols: i.columns.map(idOf).filter(Boolean), _id: ++uid }));
  const complexIdx = model.indexes.filter((i) => i.complex);
  const fks = model.foreignKeys.map((f) => ({ ...f, cols: f.columns.map(idOf).filter(Boolean), _id: ++uid }));
  const tbl = { name: model.name || '', comment: model.comment || '', engine: model.engine };

  const panel = h('div');
  const nameIn = h('input', { class: 'input', style: { font: '600 15px var(--display)', height: '36px' }, value: tbl.name, placeholder: t('table_name') });
  const commentIn = h('input', { class: 'input', value: tbl.comment, placeholder: t('Table comment (optional)') });
  const engineSel = type === 'mysql' ? select(['InnoDB', 'MyISAM', 'Aria', 'MEMORY'], tbl.engine || 'InnoDB', { style: { width: '120px' } }) : null;
  const bPreview = h('button', { class: 'btn sm', html: icon('panel-right') + `<span>${t('SQL preview')}</span>` });
  const bSave = h('button', { class: 'btn sm primary', html: icon('save') + `<span>${table ? t('Save changes') : t('Create table')}</span>` });
  const head = h(
    'div',
    { class: 'toolbar', style: { gap: '10px' } },
    h('span', { class: 'chip info', html: icon(table ? 'pencil-ruler' : 'sparkles') + (table ? t('Edit table') : t('New table')) }),
    h('div', { style: { width: '240px' } }, nameIn),
    h('div', { class: 'grow', style: { minWidth: '160px' } }, commentIn),
    engineSel,
    bPreview,
    bSave,
  );

  const colBody = h('tbody');
  const idxBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  const fkBody = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  const datalist = h('datalist', { id: `types-${++uid}` }, ...TYPES[type].map((t) => h('option', { value: t })));

  const colCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title', html: icon('columns-3') + t('Columns') }),
    h(
      'table',
      { class: 'd-table' },
      h('thead', {}, h('tr', {}, ...['', t('Name'), t('Type'), 'Null', 'PK', 'Auto', 'Default', type === 'sqlite' ? null : t('Comment'), ''].filter((x) => x !== null).map((x) => h('th', { text: x })))),
      colBody,
    ),
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', html: icon('plus') + `<span>${t('Column')}</span>`, onclick: () => addColumn() }), h('span', { class: 'faint', style: { fontSize: '11.5px' }, text: t('Drag ⠿ to reorder · Text defaults are quoted automatically; write expressions such as CURRENT_TIMESTAMP as is.') })),
    datalist,
  );
  const idxCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title', html: icon('list-ordered') + t('Indexes') }),
    idxBody,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', html: icon('plus') + `<span>${t('Index')}</span>`, onclick: () => addIndex() })),
    complexIdx.length ? h('div', { class: 'faint', style: { marginTop: '8px', fontSize: '11.5px' }, text: plural(complexIdx.length, '{n} expression-based index is not shown and will not be changed.', '{n} expression-based indexes are not shown and will not be changed.') }) : null,
  );
  const fkCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-title', html: icon('git-fork') + t('Relations (foreign keys)') }),
    fkBody,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', html: icon('plus') + `<span>${t('Relation')}</span>`, onclick: () => addFk() })),
  );
  const previewBox = h('div', { class: 'code-box' });
  const warnBox = h('div', { style: { padding: '0 10px', display: 'flex', flexDirection: 'column', gap: '6px' } });
  const preview = h('div', { class: 'd-preview' }, h('div', { class: 'toolbar', html: `${icon('file-code-2')}<b>SQL</b><span class="spacer"></span><span class="chip" id="pv-state">${t('ready')}</span>` }), warnBox, previewBox);
  const designer = h('div', { class: 'designer' }, h('div', { class: 'd-main' }, colCard, idxCard, fkCard), preview);
  panel.append(head, designer);

  const tab = {
    kind: 'designer',
    icon: 'pencil-ruler',
    title: table ? t('Design: {name}', { name: table }) : t('New table'),
    connId: a.conn.id,
    connType: type,
    ns: a.ns,
    table,
    panel,
    dirty: false,
    isDirty: () => tab.dirty,
    onActivate: () => tab.pv?.refresh(),
    onSave: () => save(),
  };
  addTab(tab);
  const pv = createEditor(previewBox, { type, readOnly: true, lineWrapping: true });
  tab.pv = pv;
  let showPreview = true;
  bPreview.onclick = () => {
    showPreview = !showPreview;
    designer.classList.toggle('no-preview', !showPreview);
    if (showPreview) setTimeout(() => pv.refresh(), 50);
  };

  // ---- model ↔ server
  function buildModel() {
    const ordered = cols.filter((c) => c.name.trim());
    return {
      name: nameIn.value.trim(),
      comment: commentIn.value.trim(),
      engine: engineSel?.value || null,
      columns: ordered.map((c) => ({
        name: c.name.trim(),
        type: c.type.trim(),
        nullable: !c.pk && c.nullable,
        default: c.autoIncrement ? null : encodeDefault(c.defaultInput, c.origName !== undefined ? c.defaultOrig : undefined),
        autoIncrement: c.autoIncrement,
        comment: c.comment || '',
        onUpdateNow: c.onUpdateNow,
        generated: c.generated,
        identity: c.identity,
        ...(c.origName !== undefined ? { origName: c.origName } : {}),
      })),
      primaryKey: ordered.filter((c) => c.pk).map((c) => c.name.trim()),
      indexes: indexes.filter((i) => i.cols.length).map((i) => ({ name: i.name.trim() || null, unique: i.unique, columns: i.cols.map(nameOf).filter(Boolean) })),
      foreignKeys: fks
        .filter((f) => f.cols.length && f.refTable && f.refColumns.length)
        .map((f) => ({ name: f.name?.trim() || null, columns: f.cols.map(nameOf).filter(Boolean), refTable: f.refTable, refColumns: f.refColumns, onDelete: f.onDelete || 'NO ACTION', onUpdate: f.onUpdate || 'NO ACTION' })),
    };
  }
  async function generate() {
    const m = buildModel();
    if (table) return api('POST', `/api/c/${a.conn.id}/sql/alter-table`, { ns: a.ns, table, model: m });
    const r = await api('POST', `/api/c/${a.conn.id}/sql/create-table`, { ns: a.ns, model: m });
    return { statements: r.statements, warnings: [] };
  }
  const pvState = () => preview.querySelector('#pv-state');
  const refresh = debounce(async () => {
    pvState().textContent = t('updating…');
    try {
      const r = await generate();
      pv.setValue(r.statements.join('\n\n') || '-- ' + t('No changes'));
      warnBox.innerHTML = '';
      for (const w of r.warnings || []) warnBox.append(h('div', { class: 'notice warn', style: { fontSize: '11.5px' }, html: icon('triangle-alert') + `<div>${esc(w)}</div>` }));
      pvState().className = 'chip ok';
      pvState().textContent = plural(r.statements.length, '{n} statement', '{n} statements');
    } catch (e) {
      pv.setValue('-- ' + e.message);
      pvState().className = 'chip danger';
      pvState().textContent = t('not valid yet');
    }
  }, 350);
  const changed = () => {
    tab.dirty = true;
    renderTabs();
    refresh();
  };
  nameIn.oninput = commentIn.oninput = changed;
  if (engineSel) engineSel.onchange = changed;

  // ---- columns
  let dragId = null;
  function renderColumns() {
    colBody.innerHTML = '';
    cols.forEach((c, i) => {
      const name = h('input', { class: 'input mono', value: c.name, placeholder: t('column') });
      const ty = h('input', { class: 'input mono', value: c.type, list: datalist.id, placeholder: t('type') });
      const nul = checkbox('', c.nullable && !c.pk, (v) => ((c.nullable = v), changed()));
      const pk = checkbox('', c.pk, (v) => {
        c.pk = v;
        if (v) c.nullable = false;
        renderColumns();
        changed();
      });
      const ai = checkbox('', c.autoIncrement, (v) => {
        c.autoIncrement = v;
        if (v) {
          c.pk = true;
          c.nullable = false;
        }
        renderColumns();
        changed();
      });
      const def = h('input', { class: 'input mono', value: c.defaultInput, placeholder: c.autoIncrement ? 'auto' : 'NULL', disabled: c.autoIncrement || Boolean(c.generated) });
      const com = h('input', { class: 'input', value: c.comment || '' });
      name.oninput = () => ((c.name = name.value), changed());
      ty.oninput = () => ((c.type = ty.value), changed());
      def.oninput = () => ((c.defaultInput = def.value), changed());
      com.oninput = () => ((c.comment = com.value), changed());
      const del = h('button', { class: 'btn ghost xs icon danger', title: t('Delete column'), html: icon('x') });
      const grip = h('td', { class: 'grip', title: t('Drag to reorder'), html: icon('grip-vertical') });
      const tr = h(
        'tr',
        { class: 'd-row', style: { animationDelay: `${Math.min(i, 20) * 22}ms` } },
        grip,
        h('td', { style: { width: '22%' } }, name),
        h('td', { style: { width: '19%' } }, ty),
        h('td', { class: 'c' }, nul),
        h('td', { class: 'c' }, pk),
        h('td', { class: 'c' }, ai),
        h('td', { style: { width: '18%' } }, def),
        type === 'sqlite' ? null : h('td', {}, com),
        h('td', {}, del),
      );
      if (c.generated) tr.title = t('Generated column: {expr}', { expr: c.generated.expr });
      del.onclick = () => {
        tr.classList.add('removing');
        setTimeout(() => {
          cols.splice(cols.indexOf(c), 1);
          for (const ix of indexes) ix.cols = ix.cols.filter((x) => x !== c._id);
          for (const f of fks) f.cols = f.cols.filter((x) => x !== c._id);
          renderColumns();
          renderIndexes();
          renderFks();
          changed();
        }, 250);
      };
      grip.addEventListener('pointerdown', () => (tr.draggable = true));
      tr.addEventListener('dragend', () => (tr.draggable = false));
      tr.addEventListener('dragstart', (e) => {
        dragId = c._id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', c.name);
      });
      tr.addEventListener('dragover', (e) => {
        e.preventDefault();
        tr.classList.add('drag-over');
      });
      tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        tr.classList.remove('drag-over');
        const from = cols.findIndex((x) => x._id === dragId);
        if (from < 0 || from === i) return;
        const [moved] = cols.splice(from, 1);
        cols.splice(cols.indexOf(c) + (from < i ? 1 : 0), 0, moved);
        renderColumns();
        changed();
      });
      colBody.append(tr);
    });
  }
  function addColumn() {
    cols.push({ _id: ++uid, name: `${LANG === 'id' ? 'kolom' : 'column'}_${cols.length + 1}`, type: TYPES[type][type === 'sqlite' ? 3 : 7], nullable: true, defaultInput: '', autoIncrement: false, pk: false, comment: '' });
    renderColumns();
    changed();
    setTimeout(() => colBody.lastElementChild?.querySelector('input')?.select(), 30);
  }

  // ---- indexes
  const colOptions = () => cols.filter((c) => c.name.trim()).map((c) => ({ value: c._id, label: c.name }));
  function pickerButton(getIds, setIds, options = colOptions) {
    const b = h('button', { class: 'input mono', type: 'button' });
    const label = () => (b.textContent = getIds().map(nameOf).filter(Boolean).join(', ') || t('choose columns…'));
    label();
    b.onclick = () =>
      multiPick(b, options(), getIds(), (ids) => {
        setIds(ids);
        label();
        changed();
      });
    return h('div', { class: 'multi grow' }, b);
  }
  function renderIndexes() {
    idxBody.innerHTML = '';
    if (!indexes.length) idxBody.append(h('div', { class: 'faint', text: t('No indexes yet (besides the primary key).') }));
    for (const ix of indexes) {
      const name = h('input', { class: 'input mono', value: ix.name || '', placeholder: t('index_name (automatic)'), style: { width: '220px' } });
      name.oninput = () => ((ix.name = name.value), changed());
      const uq = checkbox('Unique', ix.unique, (v) => ((ix.unique = v), changed()));
      const del = h('button', { class: 'btn ghost xs icon danger', html: icon('x'), onclick: () => (indexes.splice(indexes.indexOf(ix), 1), renderIndexes(), changed()) });
      idxBody.append(h('div', { class: 'row d-row', style: { animation: 'item-in .4s var(--ease) both' } }, name, pickerButton(() => ix.cols, (v) => (ix.cols = v)), uq, del));
    }
  }
  function addIndex() {
    indexes.push({ _id: ++uid, name: '', unique: false, cols: [] });
    renderIndexes();
    changed();
  }

  // ---- foreign keys
  const tableNames = () => state.tables.filter((t) => t.kind === 'table').map((t) => t.name);
  function renderFks() {
    fkBody.innerHTML = '';
    if (!fks.length) fkBody.append(h('div', { class: 'faint', text: t('No relations yet. Add one to link columns to another table.') }));
    for (const f of fks) {
      const name = h('input', { class: 'input mono', value: f.name || '', placeholder: t('name (automatic)'), style: { width: '170px' } });
      name.oninput = () => ((f.name = name.value), changed());
      const refSel = select([{ value: '', label: t('— referenced table —') }, ...tableNames().map((t) => ({ value: t, label: t }))], f.refTable || '', { style: { width: '170px' } });
      const refCols = () => (state.columns[f.refTable] || []).map((c) => ({ value: c, label: c }));
      const refBtn = h('button', { class: 'input mono', type: 'button' });
      const refLabel = () => (refBtn.textContent = f.refColumns?.join(', ') || t('referenced columns…'));
      refLabel();
      refBtn.onclick = () => multiPick(refBtn, refCols(), f.refColumns || [], (v) => ((f.refColumns = v), refLabel(), changed()));
      refSel.onchange = () => {
        f.refTable = refSel.value;
        const pkGuess = (state.columns[f.refTable] || []).includes('id') ? ['id'] : (state.columns[f.refTable] || []).slice(0, 1);
        f.refColumns = pkGuess;
        if (!f.name) f.name = '';
        refLabel();
        changed();
      };
      const onDel = select(RULES, f.onDelete || 'NO ACTION', { class: 'select sm', title: 'ON DELETE', style: { width: '120px' } });
      const onUpd = select(RULES, f.onUpdate || 'NO ACTION', { class: 'select sm', title: 'ON UPDATE', style: { width: '120px' } });
      onDel.onchange = () => ((f.onDelete = onDel.value), changed());
      onUpd.onchange = () => ((f.onUpdate = onUpd.value), changed());
      const del = h('button', { class: 'btn ghost xs icon danger', html: icon('x'), onclick: () => (fks.splice(fks.indexOf(f), 1), renderFks(), changed()) });
      fkBody.append(
        h(
          'div',
          { class: 'row wrap d-row', style: { animation: 'item-in .4s var(--ease) both', padding: '8px', borderRadius: '10px', background: 'var(--glass-2)' } },
          name,
          pickerButton(() => f.cols, (v) => (f.cols = v)),
          h('span', { class: 'flow-arrow', html: icon('arrow-right') }),
          refSel,
          h('div', { class: 'multi', style: { width: '150px' } }, refBtn),
          h('span', { class: 'faint', style: { fontSize: '11px' }, text: 'DELETE' }),
          onDel,
          h('span', { class: 'faint', style: { fontSize: '11px' }, text: 'UPDATE' }),
          onUpd,
          del,
        ),
      );
    }
  }
  function addFk() {
    fks.push({ _id: ++uid, name: '', cols: [], refTable: '', refColumns: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
    renderFks();
    changed();
  }

  // ---- save
  async function save() {
    let r;
    try {
      r = await generate();
    } catch (e) {
      return toast(e.message, 'err', { title: t('Design is not valid yet') });
    }
    if (!r.statements.length) return toast(t('No changes to save'), 'info');
    const ok = await sqlPreview({
      title: table ? t('Alter table {name}', { name: table }) : t('Create table {name}', { name: nameIn.value.trim() }),
      sub: `${TYPE_LABEL[type]} · ${a.ns}`,
      statements: r.statements,
      warnings: r.warnings,
      connId: a.conn.id,
      ns: a.ns,
      type,
      confirmLabel: table ? t('Apply changes') : t('Create table'),
    });
    if (!ok) return;
    const finalName = nameIn.value.trim();
    toast(table ? t('Table structure updated') : t('Table {name} created', { name: finalName }), 'ok', { title: t('Success') });
    invalidateSchema();
    tab.dirty = false;
    await app.loadTree();
    for (const t of state.tabs.filter((t) => t.kind === 'table' && t.connId === a.conn.id && t.table === table)) await closeTab(t.id, true);
    await closeTab(tab.id, true);
    app.openTableTab(finalName, 'structure');
  }
  bSave.onclick = save;

  renderColumns();
  renderIndexes();
  renderFks();
  refresh();
  if (!table) setTimeout(() => nameIn.focus(), 80);
  void confirmDialog;
}

Object.assign(app, { openDesigner });
