// Schema operations: create/drop database or schema, rename/truncate/drop tables, routine & trigger definitions.
import { h, icon, esc, api, qs, state, app, toast, modal, sqlPreview, promptDialog, segmented, select, field, connById, quoteIdent, qualify, TYPE_LABEL, nsLabel, COLORS } from './core.js';
import { closeTab } from './tabs.js';
import { forgetNamespaces } from './conn.js';
import { invalidateSchema } from './table.js';

export async function createNamespace({ connId = state.active?.conn.id, onCreated } = {}) {
  const conn = connById(connId);
  if (!conn) return toast('Pilih koneksi dulu', 'err');
  const type = conn.type;
  if (type === 'sqlite') {
    modal({
      title: 'Database SQLite baru',
      icon: 'database',
      body: h('div', { class: 'muted', html: 'Di SQLite, <b>satu file = satu database</b>. Buat koneksi SQLite baru dengan path file yang belum ada — file-nya akan dibuat otomatis saat terhubung.' }),
      actions: ['spacer', { label: 'Tutup' }, { label: 'Koneksi SQLite baru', kind: 'primary', icon: 'plus', onClick: () => (setTimeout(() => app.openConnDialog(null, { type: 'sqlite' })), true) }],
    });
    return;
  }
  const name = h('input', { class: 'input mono', placeholder: type === 'postgres' ? 'nama_schema' : 'nama_database' });
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  let kind = 'schema';
  let charset;
  let collation;
  const hint = h('div', { class: 'notice info', hidden: true, html: `${icon('info')}<div>Koneksi PostgreSQL terikat ke satu database. Setelah dibuat, DBStudio otomatis menambahkan koneksi baru ke database tersebut.</div>` });
  if (type === 'postgres') {
    body.append(
      field('Jenis', segmented([{ value: 'schema', label: 'Schema di database ini', icon: 'folder' }, { value: 'database', label: 'Database baru', icon: 'database' }], 'schema', (v) => {
        kind = v;
        name.placeholder = v === 'database' ? 'nama_database' : 'nama_schema';
        hint.hidden = v !== 'database';
      })),
      field('Nama', name),
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
    body.append(field('Nama database', name), h('div', { class: 'form-grid' }, field('Character set', charset), field('Collation', collation)));
  }
  modal({
    title: `${type === 'postgres' ? 'Schema / database' : 'Database'} baru`,
    sub: `${conn.name} · ${TYPE_LABEL[type]}`,
    icon: 'folder-plus',
    body,
    actions: [
      'spacer',
      { label: 'Batal' },
      {
        label: 'Lanjut',
        kind: 'primary',
        icon: 'arrow-right',
        onClick: async () => {
          const n = name.value.trim();
          if (!n) throw new Error('Nama wajib diisi');
          const { statements } = await api('POST', `/api/c/${connId}/sql/namespace`, { action: 'create', name: n, kind, charset: charset?.value, collation: collation?.value });
          setTimeout(async () => {
            const ok = await sqlPreview({ title: `Buat ${kind === 'database' || type === 'mysql' ? 'database' : 'schema'} ${n}`, statements, connId, type, confirmLabel: 'Buat' });
            if (!ok) return;
            toast(`${n} dibuat`, 'ok', { title: 'Berhasil' });
            forgetNamespaces(connId);
            if (type === 'postgres' && kind === 'database') {
              const { id, hasPassword, ...rest } = conn;
              const created = await api('POST', '/api/connections', { ...rest, database: n, name: `${conn.name} / ${n}`, copyPasswordFrom: id, color: COLORS[(COLORS.indexOf(conn.color) + 1) % COLORS.length] });
              await app.loadConns();
              toast('Koneksi baru ditambahkan', 'ok', { title: `${conn.name} / ${n}` });
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
    title: `Hapus ${nsLabel(type).toLowerCase()} "${ns}"?`,
    icon: 'triangle-alert',
    danger: true,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, h('div', { class: 'notice danger', html: `${icon('flame')}<div>Semua tabel, view, data, dan routine di dalamnya akan <b>hilang permanen</b>. Tindakan ini tidak bisa dibatalkan.</div>` }), field(`Ketik "${ns}" untuk konfirmasi`, confirmInput)),
    actions: [
      'spacer',
      { label: 'Batal' },
      {
        label: 'Lanjut',
        kind: 'danger solid',
        onClick: async () => {
          if (confirmInput.value.trim() !== ns) throw new Error('Nama tidak cocok');
          const { statements } = await api('POST', `/api/c/${a.conn.id}/sql/namespace`, { action: 'drop', name: ns, kind: 'schema' });
          setTimeout(async () => {
            const ok = await sqlPreview({ title: `Hapus ${ns}`, statements, connId: a.conn.id, type, danger: true, confirmLabel: 'Hapus permanen' });
            if (!ok) return;
            toast(`${ns} dihapus`, 'ok');
            for (const t of [...state.tabs]) if (t.connId === a.conn.id && t.ns === ns) await closeTab(t.id, true);
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
    newName = await promptDialog({ title: `Ganti nama ${kind === 'view' ? 'view' : 'tabel'}`, label: 'Nama baru', value: table, icon: 'text-cursor-input' });
    if (!newName || newName === table) return;
  }
  try {
    const { statements } = await api('POST', `/api/c/${a.conn.id}/sql/table-op`, { ns: a.ns, op, table, newName, kind });
    const danger = op !== 'rename';
    const warn = {
      drop: [`${kind === 'view' ? 'View' : 'Tabel'} "${table}" dan seluruh datanya akan dihapus permanen.`],
      truncate: [`Semua baris di "${table}" akan dihapus permanen.`],
      rename: [],
    }[op];
    const ok = await sqlPreview({
      title: { drop: `Hapus ${table}`, truncate: `Kosongkan ${table}`, rename: `Ganti nama ${table} → ${newName}` }[op],
      sub: `${TYPE_LABEL[type]} · ${a.ns}`,
      statements,
      warnings: warn,
      connId: a.conn.id,
      ns: a.ns,
      type,
      danger,
      confirmLabel: { drop: 'Hapus', truncate: 'Kosongkan', rename: 'Ganti nama' }[op],
    });
    if (!ok) return;
    toast({ drop: `${table} dihapus`, truncate: `${table} dikosongkan`, rename: `${table} → ${newName}` }[op], 'ok');
    invalidateSchema();
    if (op !== 'truncate') for (const t of [...state.tabs]) if (t.connId === a.conn.id && t.ns === a.ns && t.table === table) await closeTab(t.id, true);
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
  const t = a.conn.type;
  const what = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT' }[kind];
  let sql;
  if (t === 'mysql') sql = `DROP ${what} ${qualify(t, a.ns, item.name)};`;
  else if (t === 'postgres') {
    if (kind === 'trigger') sql = `DROP TRIGGER ${quoteIdent(item.name, t)} ON ${qualify(t, a.ns, item.tbl)};`;
    else {
      const m = /^([^(]+)(\(.*\))$/.exec(item.name);
      sql = `DROP ${what} ${quoteIdent(a.ns, t)}.${quoteIdent(m ? m[1] : item.name, t)}${m ? m[2] : ''};`;
    }
  } else sql = `DROP TRIGGER ${quoteIdent(item.name, t)};`;
  const ok = await sqlPreview({ title: `Hapus ${kind} ${item.name}`, statements: [sql], connId: a.conn.id, ns: a.ns, type: t, danger: true, confirmLabel: 'Hapus' });
  if (ok) {
    toast(`${item.name} dihapus`, 'ok');
    app.loadTree();
  }
}

export function openTool(name, opts = {}) {
  const needConn = ['erd', 'transfer', 'server'];
  if (needConn.includes(name) && !state.active) {
    toast('Hubungkan ke database dulu', 'err', { title: 'Belum terhubung' });
    return app.showPanel('connections');
  }
  ({ erd: () => app.openErd(opts), copy: () => app.openCopy(opts), transfer: () => app.openTransfer(opts), compare: () => app.openCompare(opts), server: () => app.openServer(opts) })[name]?.();
}

Object.assign(app, { createNamespace, dropNamespace, tableOp, showObjectDef, dropObject, openTool });
void esc;
