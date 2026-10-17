// Schema operations: create/drop database or schema, rename/truncate/drop tables, routine & trigger definitions.
import { h, icon, esc, api, qs, state, app, toast, modal, sqlPreview, promptDialog, segmented, select, field, connById, quoteIdent, qualify, TYPE_LABEL, COLORS } from './core.js';
import { closeTab } from './tabs.js';
import { forgetNamespaces } from './conn.js';
import { invalidateSchema } from './table.js';
import { t } from './i18n.js';

export async function createNamespace({ connId = state.active?.conn.id, onCreated } = {}) {
  const conn = connById(connId);
  if (!conn) return toast(t('Select a connection first'), 'err');
  const type = conn.type;
  if (type === 'sqlite') {
    modal({
      title: t('New SQLite database'),
      icon: 'database',
      body: h('div', { class: 'muted', html: t('In SQLite, <b>one file is one database</b>. Create a new SQLite connection with a file path that does not exist yet — the file is created automatically when you connect.') }),
      actions: ['spacer', { label: t('Close') }, { label: t('New SQLite connection'), kind: 'primary', icon: 'plus', onClick: () => (setTimeout(() => app.openConnDialog(null, { type: 'sqlite' })), true) }],
    });
    return;
  }
  const name = h('input', { class: 'input mono', placeholder: type === 'postgres' ? t('schema_name') : t('database_name') });
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  let kind = 'schema';
  let charset;
  let collation;
  const hint = h('div', { class: 'notice info', hidden: true, html: `${icon('info')}<div>${t('A PostgreSQL connection is bound to a single database. Once it is created, DBStudio automatically adds a new connection to it.')}</div>` });
  if (type === 'postgres') {
    body.append(
      field(t('Type'), segmented([{ value: 'schema', label: t('Schema in this database'), icon: 'folder' }, { value: 'database', label: t('New database'), icon: 'database' }], 'schema', (v) => {
        kind = v;
        name.placeholder = v === 'database' ? t('database_name') : t('schema_name');
        hint.hidden = v !== 'database';
      })),
      field(t('Name'), name),
      hint,
    );
  } else {
    const cs = await api('GET', `/api/c/${connId}/charsets`).catch(() => ({ charsets: [], collations: [] }));
    charset = select(cs.charsets.map((c) => ({ value: c.name, label: c.name })), 'utf8mb4');
    collation = h('select', { class: 'select' });
    const fillColl = () => {
      collation.innerHTML = '';
      const def = cs.charsets.find((c) => c.name === charset.value)?.def;
      for (const c of cs.collations.filter((x) => x.cs === charset.value)) collation.append(h('option', { value: c.name, selected: c.name === (charset.value === 'utf8mb4' && cs.collations.some((x) => x.name === 'utf8mb4_unicode_ci') ? 'utf8mb4_unicode_ci' : def) }, c.name));
    };
    charset.onchange = fillColl;
    fillColl();
    body.append(field(t('Database name'), name), h('div', { class: 'form-grid' }, field('Character set', charset), field('Collation', collation)));
  }
  modal({
    title: type === 'postgres' ? t('New schema / database') : t('New database'),
    sub: `${conn.name} · ${TYPE_LABEL[type]}`,
    icon: 'folder-plus',
    body,
    actions: [
      'spacer',
      { label: t('Cancel') },
      {
        label: t('Continue'),
        kind: 'primary',
        icon: 'arrow-right',
        onClick: async () => {
          const n = name.value.trim();
          if (!n) throw new Error(t('Name is required'));
          const { statements } = await api('POST', `/api/c/${connId}/sql/namespace`, { action: 'create', name: n, kind, charset: charset?.value, collation: collation?.value });
          setTimeout(async () => {
            const ok = await sqlPreview({ title: kind === 'database' || type === 'mysql' ? t('Create database {name}', { name: n }) : t('Create schema {name}', { name: n }), statements, connId, type, confirmLabel: t('Create') });
            if (!ok) return;
            toast(t('{name} created', { name: n }), 'ok', { title: t('Success') });
            forgetNamespaces(connId);
            if (type === 'postgres' && kind === 'database') {
              const { id, hasPassword, ...rest } = conn;
              const created = await api('POST', '/api/connections', { ...rest, database: n, name: `${conn.name} / ${n}`, copyPasswordFrom: id, color: COLORS[(COLORS.indexOf(conn.color) + 1) % COLORS.length] });
              await app.loadConns();
              toast(t('New connection added'), 'ok', { title: `${conn.name} / ${n}` });
              onCreated?.(n, created.id);
              return;
            }
            if (state.active?.conn.id === connId) {
              await app.refreshNamespaces();
              await app.setNamespace(n);
            }
            onCreated?.(n);
          });
          return true;
        },
      },
    ],
  });
}

export async function dropNamespace(ns) {
  const a = state.active;
  if (!a) return;
  const type = a.conn.type;
  const confirmInput = h('input', { class: 'input mono', placeholder: ns });
  modal({
    title: type === 'postgres' ? t('Drop schema "{name}"?', { name: ns }) : t('Drop database "{name}"?', { name: ns }),
    icon: 'triangle-alert',
    danger: true,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, h('div', { class: 'notice danger', html: `${icon('flame')}<div>${t('All tables, views, data and routines in it will be <b>permanently lost</b>. This cannot be undone.')}</div>` }), field(t('Type "{name}" to confirm', { name: ns }), confirmInput)),
    actions: [
      'spacer',
      { label: t('Cancel') },
      {
        label: t('Continue'),
        kind: 'danger solid',
        onClick: async () => {
          if (confirmInput.value.trim() !== ns) throw new Error(t('Name does not match'));
          const { statements } = await api('POST', `/api/c/${a.conn.id}/sql/namespace`, { action: 'drop', name: ns, kind: 'schema' });
          setTimeout(async () => {
            const ok = await sqlPreview({ title: t('Drop {name}', { name: ns }), statements, connId: a.conn.id, type, danger: true, confirmLabel: t('Drop permanently') });
            if (!ok) return;
            toast(t('{name} dropped', { name: ns }), 'ok');
            for (const tb of [...state.tabs]) if (tb.connId === a.conn.id && tb.ns === ns) await closeTab(tb.id, true);
            forgetNamespaces(a.conn.id);
            await app.refreshNamespaces();
            await app.loadTree();
          });
          return true;
        },
      },
    ],
  });
}

export async function tableOp(op, table, kind = 'table') {
  const a = state.active;
  if (!a) return;
  const type = a.conn.type;
  let newName;
  if (op === 'rename') {
    newName = await promptDialog({ title: kind === 'view' ? t('Rename view') : t('Rename table'), label: t('New name'), value: table, icon: 'text-cursor-input' });
    if (!newName || newName === table) return;
  }
  try {
    const { statements } = await api('POST', `/api/c/${a.conn.id}/sql/table-op`, { ns: a.ns, op, table, newName, kind });
    const danger = op !== 'rename';
    const warn = {
      drop: [kind === 'view' ? t('View "{name}" and all its data will be permanently deleted.', { name: table }) : t('Table "{name}" and all its data will be permanently deleted.', { name: table })],
      truncate: [t('All rows in "{name}" will be permanently deleted.', { name: table })],
      rename: [],
    }[op];
    const ok = await sqlPreview({
      title: { drop: t('Drop {name}', { name: table }), truncate: t('Truncate {name}', { name: table }), rename: t('Rename {name} → {newName}', { name: table, newName }) }[op],
      sub: `${TYPE_LABEL[type]} · ${a.ns}`,
      statements,
      warnings: warn,
      connId: a.conn.id,
      ns: a.ns,
      type,
      danger,
      confirmLabel: { drop: t('Drop'), truncate: t('Truncate'), rename: t('Rename') }[op],
    });
    if (!ok) return;
    toast({ drop: t('{name} dropped', { name: table }), truncate: t('{name} truncated', { name: table }), rename: `${table} → ${newName}` }[op], 'ok');
    invalidateSchema();
    if (op !== 'truncate') for (const tb of [...state.tabs]) if (tb.connId === a.conn.id && tb.ns === a.ns && tb.table === table) await closeTab(tb.id, true);
    await app.loadTree();
    if (op === 'rename') app.openTableTab(newName);
  } catch (e) {
    toast(e.message, 'err');
  }
}

export async function showObjectDef(kind, item) {
  const a = state.active;
  if (!a) return;
  try {
    const { sql } = await api('GET', `/api/c/${a.conn.id}/object-def${qs({ ns: a.ns, kind, name: item.name, oid: item.id })}`);
    app.newQueryTab(sql, false, item.name.replace(/\(.*$/, ''));
  } catch (e) {
    toast(e.message, 'err');
  }
}

export async function dropObject(kind, item) {
  const a = state.active;
  const ty = a.conn.type;
  const what = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT' }[kind];
  let sql;
  if (ty === 'mysql') sql = `DROP ${what} ${qualify(ty, a.ns, item.name)};`;
  else if (ty === 'postgres') {
    if (kind === 'trigger') sql = `DROP TRIGGER ${quoteIdent(item.name, ty)} ON ${qualify(ty, a.ns, item.tbl)};`;
    else {
      const m = /^([^(]+)(\(.*\))$/.exec(item.name);
      sql = `DROP ${what} ${quoteIdent(a.ns, ty)}.${quoteIdent(m ? m[1] : item.name, ty)}${m ? m[2] : ''};`;
    }
  } else sql = `DROP TRIGGER ${quoteIdent(item.name, ty)};`;
  const title = {
    procedure: t('Drop procedure {name}', { name: item.name }),
    function: t('Drop function {name}', { name: item.name }),
    trigger: t('Drop trigger {name}', { name: item.name }),
    event: t('Drop event {name}', { name: item.name }),
  }[kind];
  const ok = await sqlPreview({ title, statements: [sql], connId: a.conn.id, ns: a.ns, type: ty, danger: true, confirmLabel: t('Drop') });
  if (ok) {
    toast(t('{name} dropped', { name: item.name }), 'ok');
    app.loadTree();
  }
}

export function openTool(name, opts = {}) {
  const needConn = ['erd', 'transfer', 'server', 'datagen', 'finder', 'qb', 'dictionary', 'backup'];
  if (needConn.includes(name) && !state.active) {
    toast(t('Connect to a database first'), 'err', { title: t('Not connected') });
    return app.showPanel('connections');
  }
  ({
    erd: () => app.openErd(opts),
    copy: () => app.openCopy(opts),
    transfer: () => app.openTransfer(opts),
    compare: () => app.openCompare(opts),
    server: () => app.openServer(opts),
    datasync: () => app.openDataSync(opts),
    datagen: () => app.openDataGen(opts),
    finder: () => app.openFinder(opts),
    qb: () => app.openQueryBuilder(opts),
    dictionary: () => app.openDictionary(opts),
    backup: () => app.openBackup(opts),
  })[name]?.();
}

Object.assign(app, { createNamespace, dropNamespace, tableOp, showObjectDef, dropObject, openTool });
void esc;
