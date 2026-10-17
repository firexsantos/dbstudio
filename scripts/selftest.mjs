// Self-test for every engine DBStudio supports.
//
//   npm run selftest                                   # SQLite only
//   DBSTUDIO_TEST_MYSQL='mysql://user:pass@127.0.0.1:3306' \
//   DBSTUDIO_TEST_PG='postgres://user:pass@127.0.0.1:5432/postgres' npm run selftest
//
// MySQL/MariaDB: creates and drops temporary DATABASEs (needs CREATE/DROP privilege).
// PostgreSQL:    creates and drops temporary SCHEMAs inside the given database.
// Your existing data is never touched.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import * as db from '../lib/drivers.js';
import * as schema from '../lib/schema.js';
import { createJob, getJob } from '../lib/jobs.js';
import { runCopy } from '../lib/copy.js';
import { runDump, runImport } from '../lib/transfer.js';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as connio from '../lib/connio.js';
import { runCompare as dsCompare, runApply as dsApply, runScript as dsScript } from '../lib/datasync.js';
import { runGenerate, planTable, generatorList } from '../lib/datagen.js';
import { runFind } from '../lib/finder.js';
import { buildDictionary } from '../lib/dictionary.js';
import { buildXlsx } from '../lib/xlsx.js';
import { createCipheriv, randomBytes } from 'node:crypto';
import * as settings from '../lib/settings.js';
import { t, plural, lang, locale } from '../lib/i18n.js';
import ID from '../public/js/locales/id.js';

const stamp = Date.now().toString(36);
let failures = 0;
let passes = 0;
const only = process.argv.slice(2);

function check(name, cond, detail = '') {
  if (cond) passes++;
  else failures++;
  if (!cond || process.env.VERBOSE) console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function fromUrl(type, raw) {
  const u = new URL(raw);
  return {
    id: `selftest-${type}`,
    type,
    host: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || undefined,
  };
}

// ---------------------------------------------------------------- engines
const engines = [];
const sqliteFiles = [];
function sqliteEngine() {
  // SQLite has one namespace per file, so every "namespace" is its own connection.
  const conns = new Map();
  return {
    type: 'sqlite',
    label: 'SQLite',
    async make(name) {
      const file = join(tmpdir(), `dbst_${stamp}_${name}.db`);
      sqliteFiles.push(file);
      const conn = { id: `sqlite-${name}`, type: 'sqlite', file };
      conns.set(name, conn);
      return { conn, ns: 'main' };
    },
    async drop(name) {
      const c = conns.get(name);
      if (!c) return;
      await db.disconnect(c.id);
      rmSync(c.file, { force: true });
      conns.delete(name);
    },
  };
}
engines.push(sqliteEngine());
if (process.env.DBSTUDIO_TEST_MYSQL) {
  const conn = fromUrl('mysql', process.env.DBSTUDIO_TEST_MYSQL);
  delete conn.database;
  engines.push({
    type: 'mysql',
    label: 'MySQL/MariaDB',
    async make(name) {
      const ns = `dbst_${stamp}_${name}`;
      await db.raw(conn, `CREATE DATABASE \`${ns}\` CHARACTER SET utf8mb4`);
      return { conn, ns };
    },
    async drop(name) {
      await db.raw(conn, `DROP DATABASE IF EXISTS \`dbst_${stamp}_${name}\``);
    },
  });
}
if (process.env.DBSTUDIO_TEST_PG) {
  const conn = fromUrl('postgres', process.env.DBSTUDIO_TEST_PG);
  engines.push({
    type: 'postgres',
    label: 'PostgreSQL',
    async make(name) {
      const ns = `dbst_${stamp}_${name}`;
      await db.raw(conn, `CREATE SCHEMA "${ns}"`);
      return { conn, ns };
    },
    async drop(name) {
      await db.raw(conn, `DROP SCHEMA IF EXISTS "dbst_${stamp}_${name}" CASCADE`);
    },
  });
}

// ---------------------------------------------------------------- fixture
const DDL = {
  mysql: `
    CREATE TABLE kategori (id INT AUTO_INCREMENT PRIMARY KEY, nama VARCHAR(50) NOT NULL UNIQUE, aktif TINYINT(1) NOT NULL DEFAULT 1, dibuat DATE DEFAULT (CURRENT_DATE)) ENGINE=InnoDB COMMENT='Kategori produk';
    CREATE TABLE produk (id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(20) NOT NULL, nama VARCHAR(100) NOT NULL COMMENT 'Nama produk',
      kategori_id INT NULL, harga DECIMAL(12,2) NOT NULL DEFAULT 0, stok INT NOT NULL DEFAULT 0,
      status ENUM('aktif','arsip') NOT NULL DEFAULT 'aktif', info JSON NULL, foto BLOB NULL, dibuat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sku (sku), KEY idx_nama (nama),
      CONSTRAINT fk_produk_kategori FOREIGN KEY (kategori_id) REFERENCES kategori(id) ON DELETE SET NULL) ENGINE=InnoDB;
    CREATE TABLE item (pesanan_id INT NOT NULL, produk_id INT NOT NULL, jumlah INT NOT NULL, PRIMARY KEY (pesanan_id, produk_id),
      CONSTRAINT fk_item_produk FOREIGN KEY (produk_id) REFERENCES produk(id) ON DELETE CASCADE) ENGINE=InnoDB;
    CREATE VIEW v_stok AS SELECT nama, stok FROM produk;`,
  postgres: `
    CREATE TABLE kategori (id SERIAL PRIMARY KEY, nama VARCHAR(50) NOT NULL UNIQUE, aktif BOOLEAN NOT NULL DEFAULT TRUE, dibuat DATE DEFAULT CURRENT_DATE, kode TEXT DEFAULT md5('x'));
    COMMENT ON TABLE kategori IS 'Kategori produk';
    CREATE TABLE produk (id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, sku VARCHAR(20) NOT NULL, nama VARCHAR(100) NOT NULL,
      kategori_id INT REFERENCES kategori(id) ON DELETE SET NULL, harga NUMERIC(12,2) NOT NULL DEFAULT 0, stok INT NOT NULL DEFAULT 0,
      status VARCHAR(10) NOT NULL DEFAULT 'aktif', info JSONB, foto BYTEA, dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX uq_sku ON produk (sku);
    CREATE INDEX idx_nama ON produk (nama);
    COMMENT ON COLUMN produk.nama IS 'Nama produk';
    CREATE TABLE item (pesanan_id INT NOT NULL, produk_id INT NOT NULL REFERENCES produk(id) ON DELETE CASCADE, jumlah INT NOT NULL,
      PRIMARY KEY (pesanan_id, produk_id));
    CREATE VIEW v_stok AS SELECT nama, stok FROM produk;`,
  sqlite: `
    CREATE TABLE kategori (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL UNIQUE, aktif BOOLEAN NOT NULL DEFAULT 1, dibuat TEXT DEFAULT (date('now')));
    CREATE TABLE produk (id INTEGER PRIMARY KEY AUTOINCREMENT, sku VARCHAR(20) NOT NULL, nama VARCHAR(100) NOT NULL,
      kategori_id INTEGER REFERENCES kategori(id) ON DELETE SET NULL, harga NUMERIC(12,2) NOT NULL DEFAULT 0, stok INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(10) NOT NULL DEFAULT 'aktif', info TEXT, foto BLOB, dibuat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX uq_sku ON produk (sku);
    CREATE INDEX idx_nama ON produk (nama);
    CREATE TABLE item (pesanan_id INTEGER NOT NULL, produk_id INTEGER NOT NULL REFERENCES produk(id) ON DELETE CASCADE, jumlah INTEGER NOT NULL,
      PRIMARY KEY (pesanan_id, produk_id));
    CREATE VIEW v_stok AS SELECT nama, stok FROM produk;`,
};

const TRICKY = "Indomie 'Goreng' \\ backslash";
const PRODUK = [
  ['A1', TRICKY, 1, '3500.50', 240, 'aktif', '{"pedas":true,"tags":["mie"]}', Buffer.from([0, 1, 2, 255])],
  ['A2', 'Beras 5kg — ünïcødé 🍚', 1, '78000.00', 35, 'aktif', null, null],
  ['B1', 'Teh\nBotol', 2, '5000.00', 150, 'arsip', '[1,2,3]', null],
  ['B2', 'Kopi', null, '14500.00', 0, 'aktif', null, null],
];

async function seed({ conn, ns }) {
  await db.raw(conn, DDL[conn.type], [], ns);
  await db.bulkInsert(conn, ns, 'kategori', ['nama', 'aktif'], [['Makanan', true], ["Minuman 'Dingin'", false]]);
  await db.bulkInsert(conn, ns, 'produk', ['sku', 'nama', 'kategori_id', 'harga', 'stok', 'status', 'info', 'foto'], PRODUK);
  await db.bulkInsert(conn, ns, 'item', ['pesanan_id', 'produk_id', 'jumlah'], [[1, 1, 2], [1, 3, 1], [2, 2, 1]]);
}

const val = async (conn, ns, sql) => (await db.raw(conn, sql, [], ns)).rows[0]?.[0];
const Q = (conn, ns, t) => db.qualified(conn.type, ns, t);
// Canonical JSON (sorted keys): PostgreSQL jsonb legitimately reorders object keys.
const sortKeys = (x) =>
  Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x;
const asJson = (v) => (v == null ? null : sortKeys(typeof v === 'string' ? JSON.parse(v) : v));
const asHex = (v) => (v == null ? null : Buffer.from(v).toString('hex'));
const truthy = (v) => v === true || Number(v) === 1;

// Verify a database holds the fixture data (after seed / copy / import).
async function verifyData(tag, { conn, ns }, { fks = true } = {}) {
  const t = conn.type;
  const count = async (tbl) => Number(await val(conn, ns, `SELECT COUNT(*) FROM ${Q(conn, ns, tbl)}`));
  check(`${tag}: row counts`, (await count('kategori')) === 2 && (await count('produk')) === 4 && (await count('item')) === 3);
  const r = await db.objects(conn, `SELECT * FROM ${Q(conn, ns, 'produk')} WHERE sku = 'A1'`, [], ns);
  const a1 = r[0] || {};
  check(`${tag}: tricky text`, a1.nama === TRICKY, JSON.stringify(a1.nama));
  check(`${tag}: decimal`, Number(a1.harga) === 3500.5, String(a1.harga));
  check(`${tag}: json`, JSON.stringify(asJson(a1.info)) === JSON.stringify(sortKeys({ pedas: true, tags: ['mie'] })), JSON.stringify(a1.info));
  check(`${tag}: blob`, asHex(a1.foto) === '000102ff', asHex(a1.foto));
  const a2 = (await db.objects(conn, `SELECT nama FROM ${Q(conn, ns, 'produk')} WHERE sku = 'A2'`, [], ns))[0];
  check(`${tag}: unicode`, a2?.nama === 'Beras 5kg — ünïcødé 🍚');
  const b1 = (await db.objects(conn, `SELECT nama, info FROM ${Q(conn, ns, 'produk')} WHERE sku = 'B1'`, [], ns))[0];
  check(`${tag}: newline + json array`, b1?.nama === 'Teh\nBotol' && JSON.stringify(asJson(b1.info)) === '[1,2,3]');
  const b2 = (await db.objects(conn, `SELECT kategori_id FROM ${Q(conn, ns, 'produk')} WHERE sku = 'B2'`, [], ns))[0];
  check(`${tag}: NULL`, b2 && b2.kategori_id === null);
  const k = await db.objects(conn, `SELECT nama, aktif FROM ${Q(conn, ns, 'kategori')} ORDER BY id`, [], ns);
  check(`${tag}: boolean`, truthy(k[0]?.aktif) && !truthy(k[1]?.aktif) && k[1]?.nama === "Minuman 'Dingin'", JSON.stringify(k));
  const models = await schema.describeSchema(conn, ns);
  const produk = models.find((m) => m.name === 'produk');
  check(`${tag}: PK + auto increment`, produk?.primaryKey.join() === 'id' && produk.columns.find((c) => c.name === 'id')?.autoIncrement);
  check(`${tag}: unique index`, produk?.indexes.some((i) => i.unique && i.columns.join() === 'sku'), JSON.stringify(produk?.indexes.map((i) => i.name + ':' + i.columns)));
  if (fks) {
    const item = models.find((m) => m.name === 'item');
    const fk = item?.foreignKeys.find((f) => f.refTable === 'produk');
    check(`${tag}: foreign key + ON DELETE`, fk && fk.columns.join() === 'produk_id' && fk.onDelete === 'CASCADE', JSON.stringify(item?.foreignKeys));
  }
  // auto increment continues after copied ids
  await db.bulkInsert(conn, ns, 'kategori', ['nama'], [['Baru ' + t]]);
  check(`${tag}: next id after copy`, Number(await val(conn, ns, `SELECT MAX(id) FROM ${Q(conn, ns, 'kategori')}`)) === 3);
  await db.raw(conn, `DELETE FROM ${Q(conn, ns, 'kategori')} WHERE id = 3`, [], ns);
}

async function job(fn) {
  const j = createJob('test', 'test', fn);
  while (j.status === 'running') await new Promise((r) => setTimeout(r, 20));
  return getJob(j.id);
}

// ---------------------------------------------------------------- suites
async function suiteSplit() {
  console.log('\nStatement splitter');
  const m = db.splitStatements("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 'a;b'; END$$\nDELIMITER ;\nSELECT 2;", 'mysql');
  check('MySQL DELIMITER', m.length === 2 && m[0].startsWith('CREATE PROCEDURE') && m[1] === 'SELECT 2', JSON.stringify(m));
  const b = db.splitStatements("SELECT 'it\\'s; ok'; SELECT 2", 'mysql');
  check('MySQL backslash escape', b.length === 2, JSON.stringify(b));
  const p = db.splitStatements('CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT 1;', 'postgres');
  check('PostgreSQL $$ body', p.length === 2, JSON.stringify(p));
  const s = db.splitStatements('CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; DELETE FROM c; END; SELECT 1;', 'sqlite');
  check('SQLite trigger body', s.length === 2, JSON.stringify(s));
  const c = db.splitStatements('-- only a comment;\n/* block; */ SELECT 1; -- trailing', 'sqlite');
  check('comments', c.length === 1, JSON.stringify(c));
}

async function suiteEngine(E) {
  console.log(`\n${E.label}: schema, DDL, ALTER`);
  const src = await E.make('src');
  await seed(src);
  await verifyData(`${E.type} seed`, src);
  const { conn, ns } = src;
  const t = conn.type;

  const models = await schema.describeSchema(conn, ns);
  const v = models.find((m) => m.name === 'v_stok');
  check('view + definition', v?.kind === 'view' && /stok/i.test(v.definition || ''), v?.definition);
  const produk = models.find((m) => m.name === 'produk');
  const dflt = produk.columns.find((c) => c.name === 'status')?.default;
  check('string default as SQL', /'aktif'/.test(String(dflt)), String(dflt));
  check('DDL text', /CREATE TABLE/i.test(await schema.tableDDL(conn, ns, 'produk')));

  // Designer-style "add one nullable column": PK columns arrive as NOT NULL from the UI; must stay a cheap ALTER.
  const addOnly = schema.alterTableSQL(produk, {
    ...produk,
    columns: [...produk.columns.map((c) => ({ ...c, origName: c.name, nullable: produk.primaryKey.includes(c.name) ? false : c.nullable })), { name: 'catatan', type: t === 'sqlite' ? 'TEXT' : 'text', nullable: true, default: null }],
  }, t, ns);
  check('add column → single ALTER (no rebuild)', addOnly.statements.length === 1 && /ADD COLUMN/i.test(addOnly.statements[0]), addOnly.statements.join(' | '));

  // round trip: recreate produk under a new name from its model
  const copyStmts = schema.createTableStatements(produk, t, { ns, srcNs: ns, name: 'produk_rt', fkMode: t === 'sqlite' ? 'inline' : 'alter' });
  await db.execScript(conn, ns, copyStmts, { transactional: false });
  const rt = await schema.describeTable(conn, ns, 'produk_rt');
  const sig = (m) => m.columns.map((c) => `${c.name}:${String(c.type).toLowerCase()}:${c.nullable}:${c.autoIncrement}`).join('|');
  check('CREATE TABLE round trip', sig(rt) === sig(produk), `\n      ${sig(produk)}\n      ${sig(rt)}`);
  check('round trip keeps FK + indexes', rt.foreignKeys.length === 1 && rt.indexes.filter((i) => !i.complex).length >= 2);

  // ALTER via designer model: rename col, add col, change type, drop col, add index + FK, rename table
  const next = {
    ...rt,
    name: 'produk_baru',
    columns: [
      ...rt.columns
        .filter((c) => c.name !== 'foto')
        .map((c) => ({ ...c, origName: c.name, ...(c.name === 'stok' ? { name: 'jumlah_stok' } : {}), ...(c.name === 'sku' ? { type: t === 'postgres' ? 'character varying(40)' : t === 'mysql' ? 'varchar(40)' : 'VARCHAR(40)' } : {}) })),
      { name: 'berat', type: t === 'mysql' ? 'decimal(8,3)' : t === 'postgres' ? 'numeric(8,3)' : 'NUMERIC(8,3)', nullable: true, default: null },
    ],
    indexes: [...rt.indexes.filter((i) => !i.complex), { name: 'idx_produk_baru_berat', columns: ['berat'], unique: false }],
  };
  const { statements, warnings } = schema.alterTableSQL(rt, next, t, ns);
  try {
    await db.execScript(conn, ns, statements);
    const after = await schema.describeTable(conn, ns, 'produk_baru');
    const names = after.columns.map((c) => c.name);
    check(
      'ALTER: rename/add/drop column + rename table',
      names.includes('jumlah_stok') && names.includes('berat') && !names.includes('foto') && !names.includes('stok'),
      names.join(','),
    );
    check('ALTER: type change', /40/.test(after.columns.find((c) => c.name === 'sku').type));
    check('ALTER: new index', after.indexes.some((i) => i.columns.join() === 'berat'));
    check('ALTER: FK survives', after.foreignKeys.length === 1, JSON.stringify(after.foreignKeys));
    const again = schema.alterTableSQL(after, { ...after, columns: after.columns.map((c) => ({ ...c, origName: c.name })) }, t, ns);
    check('ALTER: no-op produces no SQL', again.statements.length === 0, again.statements.join(' '));
  } catch (e) {
    check('ALTER applied', false, `${e.message}\n${statements.join('\n')}`);
  }
  if (warnings.length) console.log(`  (info) ${warnings.join(' ')}`);

  // namespace / table ops / compare
  check('table-op SQL', schema.tableOpSQL(t, ns, 'rename', 'a', { newName: 'b' })[0].includes('RENAME'));
  if (t !== 'sqlite') {
    const other = await E.make('cmp');
    await db.raw(other.conn, DDL[t], [], other.ns);
    await db.raw(other.conn, `ALTER TABLE ${Q(other.conn, other.ns, 'produk')} DROP COLUMN status`, [], other.ns);
    const items = await schema.compareSchemas(conn, ns, other.conn, other.ns);
    const pr = items.find((i) => i.table === 'produk');
    check('compare: detects difference', pr?.status === 'different', JSON.stringify(pr?.statements));
    check('compare: missing tables listed', items.some((i) => i.table === 'produk_baru' && i.status === 'missing'));
    for (const i of items) if (i.statements.length) await db.execScript(other.conn, other.ns, i.statements);
    const again = await schema.compareSchemas(conn, ns, other.conn, other.ns);
    check('compare: in sync after applying', again.every((i) => i.status === 'same'), JSON.stringify(again.filter((i) => i.status !== 'same')));
    await E.drop('cmp');

    // server tools
    const pl = await db.processList(conn);
    check('process list', pl.rows.length >= 1);
    check('variables', (await db.serverVariables(conn)).rows.length > 10);
    check('users', (await db.listUsers(conn)).rows.length >= 1);
  }
  return src;
}

async function suiteCopy(from, to) {
  const tag = `copy ${from.type}→${to.type}`;
  const src = await from.make('src2');
  await seed(src);
  const dst = await to.make('dst_' + from.type);
  const j = await job((ctx) =>
    runCopy(ctx, {
      src: src.conn,
      srcNs: src.ns,
      dst: dst.conn,
      dstNs: dst.ns,
      tables: ['kategori', 'produk', 'item'].map((name) => ({ name })),
      views: ['v_stok'],
      mode: 'both',
      dropExisting: true,
      foreignKeys: true,
    }),
  );
  check(`${tag}: job finished`, j.status === 'done', j.error || '');
  const warns = j.log.filter((l) => l.level !== 'info').map((l) => l.msg);
  if (warns.length) console.log(`  (info) ${tag}: ${warns.join(' | ')}`);
  if (j.status === 'done') await verifyData(tag, dst);
  const view = (await db.listTables(dst.conn, dst.ns)).find((x) => x.name === 'v_stok');
  check(`${tag}: view`, view?.kind === 'view');
  await from.drop('src2');
  await to.drop('dst_' + from.type);
}

async function suiteDump(from, to) {
  const tag = `dump ${from.type}→${to.type}`;
  const src = await from.make('dsrc');
  await seed(src);
  const d = await job((ctx) => runDump(ctx, { conn: src.conn, ns: src.ns, structure: true, data: true, dropTable: true, dialect: to.type }));
  check(`${tag}: export`, d.status === 'done', d.error || '');
  if (d.status !== 'done') return;
  const sql = readFileSync(d.file, 'utf8');
  const dst = await to.make('ddst_' + from.type);
  const imp = await job((ctx) => runImport(ctx, { conn: dst.conn, ns: dst.ns, sql }));
  check(`${tag}: import`, imp.status === 'done', imp.error || '');
  if (imp.status === 'done') await verifyData(tag, dst);
  rmSync(d.file, { force: true });
  await from.drop('dsrc');
  await to.drop('ddst_' + from.type);
}


async function suiteConnio() {
  console.log('\nConnection import / export');
  const conns = [
    { id: 'a', name: 'Prod', type: 'mysql', host: 'db.example.com', port: 3306, user: 'root', password: 'r4hasia!', database: 'toko', group: 'Kantor',
      ssh: { enabled: true, host: 'bastion', port: 22, user: 'ubuntu', auth: 'password', password: 'sshpw' } },
    { id: 'b', name: 'Lokal', type: 'sqlite', file: '/tmp/x.db' },
  ];
  const plain = connio.exportConnections(conns, { includePasswords: true });
  const back = connio.parseImport({ content: plain }).items.map((i) => i.conn);
  check('export → import (plain)', back.length === 2 && back[0].password === 'r4hasia!' && back[0].ssh.password === 'sshpw' && back[0].group === 'Kantor' && !('id' in back[0]));
  const noPw = connio.parseImport({ content: connio.exportConnections(conns, { includePasswords: false }) }).items[0].conn;
  check('export without passwords', noPw.password === undefined && noPw.ssh.password === undefined && noPw.user === 'root');
  const enc = connio.exportConnections(conns, { includePasswords: true, passphrase: 'kunci rahasia' });
  check('encrypted file hides secrets', !enc.includes('r4hasia!') && !enc.includes('db.example.com') && JSON.parse(enc).encrypted === true);
  const dec = connio.parseImport({ content: enc, passphrase: 'kunci rahasia' }).items.map((i) => i.conn);
  check('encrypted → import with passphrase', dec[0].password === 'r4hasia!' && dec[1].file === '/tmp/x.db');
  let code = '';
  try { connio.parseImport({ content: enc, passphrase: 'salah' }); } catch (e) { code = e.code; }
  check('wrong passphrase rejected', code === 'BAD_PASSPHRASE');
  try { connio.parseImport({ content: enc }); } catch (e) { code = e.code; }
  check('missing passphrase detected', code === 'NEED_PASSPHRASE');

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="Server &amp; Prod" ConnType="MYSQL" Host="10.0.0.5" Port="3307" UserName="admin" Password="${connio.navicatEncrypt('pässw0rd')}" Database="erp"
    SSH="true" SSH_Host="gw.example.com" SSH_Port="2222" SSH_UserName="deploy" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="/home/u/.ssh/id_rsa" SSH_Passphrase="${connio.navicatEncrypt('kp')}"/>
  <Connection ConnectionName="Analitik" ConnType="POSTGRESQL" Host="pg.local" Port="5432" UserName="postgres" Password="${connio.navicatEncrypt('pg!')}" InitialDatabase="dw"/>
  <Connection ConnectionName="Kas" ConnType="SQLITE" DatabaseFileName="/data/kas.db"/>
  <Connection ConnectionName="Ora" ConnType="ORACLE" Host="o"/>
</Connections>`;
  const nv = connio.parseImport({ content: ncx });
  const [m, pg, sl, ora] = nv.items;
  check('Navicat: source detected', nv.source === 'Navicat' && nv.items.length === 4);
  check('Navicat: MySQL + password decrypted', m.conn.name === 'Server & Prod' && m.conn.port === 3307 && m.conn.password === 'pässw0rd' && m.conn.database === 'erp');
  check('Navicat: SSH key + passphrase', m.conn.ssh.auth === 'key' && m.conn.ssh.port === 2222 && m.conn.ssh.passphrase === 'kp' && m.conn.ssh.keyFile === '/home/u/.ssh/id_rsa');
  check('Navicat: PostgreSQL', pg.conn.type === 'postgres' && pg.conn.password === 'pg!' && pg.conn.database === 'dw');
  check('Navicat: SQLite', sl.conn.type === 'sqlite' && sl.conn.file === '/data/kas.db');
  check('Navicat: unsupported engine skipped', ora.skip === true);
  const old = connio.parseImport({ content: '<Connections Ver="1.1"><Connection ConnectionName="x" ConnType="MYSQL" Host="h" Password="ABCD"/></Connections>' });
  check('Navicat < 12: warns, no password', old.items[0].conn.password === undefined && old.items[0].warnings.length === 1);

  const ds = { folders: {}, connections: {
    'mysql8-1': { provider: 'mysql', name: 'Toko', folder: 'Klien/ABC', configuration: { host: 'h1', port: '3306', database: 'shop' } },
    'pg-1': { provider: 'postgresql', name: 'Gudang', configuration: { host: 'h2', port: '5433', database: 'wh', handlers: { ssh_tunnel: { enabled: true, properties: { host: 'jump', port: '22', authType: 'PASSWORD' } } } } },
  } };
  const credsJson = Buffer.from(JSON.stringify({ 'mysql8-1': { '#connection': { user: 'u1', password: 'p1' } }, 'pg-1': { '#connection': { user: 'u2', password: 'p2' }, 'network/ssh_tunnel': { user: 'su', password: 'sp' } } }));
  const iv = randomBytes(16);
  const c = createCipheriv('aes-128-cbc', Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex'), iv);
  const credFile = Buffer.concat([iv, c.update(credsJson), c.final()]).toString('base64');
  const dv = connio.parseImport({ content: JSON.stringify(ds), credentials: credFile });
  const [d1, d2] = dv.items.map((i) => i.conn);
  check('DBeaver: connections + group', dv.source === 'DBeaver' && d1.type === 'mysql' && d1.group === 'ABC' && d1.database === 'shop');
  check('DBeaver: credentials decrypted', d1.user === 'u1' && d1.password === 'p1' && d2.password === 'p2' && d2.port === 5433);
  check('DBeaver: SSH tunnel', d2.ssh?.enabled && d2.ssh.host === 'jump' && d2.ssh.user === 'su' && d2.ssh.password === 'sp');

  // SQLyog .sycs (fake hosts/passwords; encoded the way SQLyog stores them)
  const E = connio.sqlyogEncode;
  const sycs = [
    '[Connection 1]', 'Name=Kantor Pusat', 'Host=db.example.com', 'User=admin', 'StorePassword=1', `Password=${E('p@ss Wörd#1')}`,
    'Port=3307', 'Database=toko;arsip', 'SSH=0', `SshPwd=${E('ignored')}`, 'SslChecked=1', 'CA=C:\\certs\\ca.pem', 'ObjectbrowserBkcolor=255',
    '[Connection 2]', 'Name=Lewat SSH', 'Host=localhost', 'User=root', 'StorePassword=1', `Password=${E('dbpw')}`, 'Port=3306', 'Database=',
    'SSH=1', 'SshUser=ubuntu', `SshPwd=${E('sshpw')}`, 'SshHost=bastion.example.com', 'SshPort=2222', 'SshPasswordRadio=1', 'SshPrivateRadio=0',
    'SshSavePassword=1', 'Tunnel=1', 'ObjectbrowserBkcolor=16777215',
    '[Connection 3]', 'Name=Kunci', 'Host=127.0.0.1', 'User=u', 'StorePassword=0', 'Password=', 'SSH=1', 'SshUser=k', 'SshHost=h',
    'SshPrivateRadio=1', 'SSHPrivateKeyPath=C:\\Users\\me\\.ssh\\id_rsa',
  ].join('\r\n');
  check('SQLyog: password encoding round-trips', connio.sqlyogDecode(E('p@ss Wörd#1')) === 'p@ss Wörd#1');
  const sy = connio.parseImport({ content: sycs, filename: 'koneksi.sycs' });
  const [y1, y2, y3] = sy.items.map((i) => i.conn);
  check('SQLyog: detected, 3 connections', sy.source === 'SQLyog' && sy.items.length === 3);
  check('SQLyog: host/port/user/password', y1.type === 'mysql' && y1.host === 'db.example.com' && y1.port === 3307 && y1.user === 'admin' && y1.password === 'p@ss Wörd#1');
  check('SQLyog: first listed database, SSL, color', y1.database === 'toko' && y1.ssl === true && y1.color === '#ff0000' && !y1.ssh);
  check('SQLyog: warnings for database list + SSL files', sy.items[0].warnings.length === 2);
  check('SQLyog: SSH tunnel with password', y2.ssh?.enabled && y2.ssh.host === 'bastion.example.com' && y2.ssh.port === 2222 && y2.ssh.user === 'ubuntu' && y2.ssh.password === 'sshpw' && y2.password === 'dbpw');
  check('SQLyog: HTTP tunnel warning, default color ignored', sy.items[1].warnings.length === 1 && !y2.color);
  check('SQLyog: SSH key auth + Windows path warning, no password', y3.ssh?.auth === 'key' && y3.ssh.keyFile.endsWith('id_rsa') && !y3.password && sy.items[2].warnings.length === 1);
  const utf16 = Buffer.from('\uFEFF' + sycs, 'utf16le').toString('utf8');
  check('SQLyog: UTF-16 export is read too', connio.parseImport({ content: utf16 }).items.length === 3);
  let badErr = '';
  try { connio.parseImport({ content: '[Connection 1]\nHost=x\nStorePassword=1\nPassword=@@@' }); } catch (e) { badErr = e.message; }
  check('SQLyog: undecodable password is skipped, not imported as garbage', !badErr);
  check('duplicate detection', connio.sameTarget(conns[0], { ...conns[0], name: 'lain', password: 'x' }) && !connio.sameTarget(conns[0], { ...conns[0], database: 'lain' }));
}

async function suiteDataSync(a, b) {
  const tag = `datasync ${a.type}→${b.type}`;
  const src = await a.make('dss');
  await seed(src);
  const dst = await b.make('dsd_' + a.type);
  const tables = ['kategori', 'produk', 'item'].map((name) => ({ name }));
  let j = await job((ctx) => runCopy(ctx, { src: src.conn, srcNs: src.ns, dst: dst.conn, dstNs: dst.ns, tables, mode: 'both', dropExisting: true, foreignKeys: true }));
  if (j.status !== 'done') return check(`${tag}: setup copy`, false, j.error);
  const D = (sql) => db.raw(dst.conn, sql, [], dst.ns);
  const T = (t) => Q(dst.conn, dst.ns, t);
  // drift the target: change a value, remove a row, add a row
  await D(`UPDATE ${T('produk')} SET harga = 1, nama = 'Diubah' WHERE sku = 'A2'`);
  await D(`DELETE FROM ${T('item')} WHERE pesanan_id = 2`);
  await D(`INSERT INTO ${T('kategori')} (id, nama, aktif) VALUES (99, 'Ekstra', ${b.type === 'postgres' ? 'TRUE' : 1})`);
  j = await job((ctx) => dsCompare(ctx, { src: src.conn, srcNs: src.ns, dst: dst.conn, dstNs: dst.ns, tables }));
  check(`${tag}: compare`, j.status === 'done', j.error || '');
  if (j.status !== 'done') return;
  const by = Object.fromEntries(j.result.tables.map((t) => [t.table, t]));
  check(`${tag}: same rows recognised`, by.kategori.same === 2 && by.produk.same === 3 && by.item.same === 2, JSON.stringify(j.result.tables.map((t) => [t.table, t.insert, t.update, t.delete, t.same])));
  check(`${tag}: diff detected`, by.produk.update === 1 && by.item.insert === 1 && by.kategori.delete === 1);
  const upd = by.produk.samples.update[0];
  check(`${tag}: changed columns`, upd && upd.changed.map((i) => by.produk.columns[i]).sort().join() === 'harga,nama', JSON.stringify(upd?.changed));
  const sel = j.result.tables.map((t) => ({ table: t.table, insert: true, update: true, delete: true }));
  const sc = await job((ctx) => dsScript(ctx, { compareId: j.id, selection: sel }));
  const sql = sc.file ? readFileSync(sc.file, 'utf8') : '';
  check(`${tag}: SQL script`, sc.status === 'done' && sc.result.statements === 3 && /UPDATE .*produk/.test(sql) && /DELETE FROM .*kategori/.test(sql), sc.error || '');
  const ap = await job((ctx) => dsApply(ctx, { compareId: j.id, selection: sel }));
  check(`${tag}: apply`, ap.status === 'done' && ap.result.applied === 3, ap.error || '');
  const again = await job((ctx) => dsCompare(ctx, { src: src.conn, srcNs: src.ns, dst: dst.conn, dstNs: dst.ns, tables }));
  check(`${tag}: in sync after apply`, again.status === 'done' && again.result.tables.every((t) => !t.insert && !t.update && !t.delete), JSON.stringify(again.result?.tables.map((t) => [t.table, t.insert, t.update, t.delete])));
  await a.drop('dss');
  await b.drop('dsd_' + a.type);
}

async function suiteDataGen(E) {
  const tag = `datagen ${E.type}`;
  const env = await E.make('gen');
  await db.raw(env.conn, DDL[env.conn.type], [], env.ns);
  const plan = await planTable(env.conn, env.ns, 'produk');
  const g = Object.fromEntries(plan.columns.map((c) => [c.name, c.spec.gen]));
  check(`${tag}: plan suggestions`, g.id === 'skip' && g.kategori_id === 'fk' && g.harga === 'money' && g.stok === 'int' && g.nama === 'product', JSON.stringify(g));
  if (E.type === 'mysql') check(`${tag}: ENUM values`, JSON.stringify(plan.columns.find((c) => c.name === 'status').list) === '["aktif","arsip"]');
  const r = await job((ctx) => runGenerate(ctx, { conn: env.conn, ns: env.ns, seed: 42, tables: [
    { table: 'item', rows: 300, mode: 'append' },
    { table: 'kategori', rows: 25, mode: 'append' },
    { table: 'produk', rows: 200, mode: 'append', columns: { sku: { gen: 'sequence', prefix: 'SKU-', start: 1, width: 5 } } },
  ] }));
  check(`${tag}: job`, r.status === 'done', r.error || '');
  if (r.status !== 'done') return E.drop('gen');
  const v = async (sql) => Number((await db.raw(env.conn, sql, [], env.ns)).rows[0][0]);
  const T = (t) => Q(env.conn, env.ns, t);
  check(`${tag}: parents generated first`, r.result.tables.map((x) => x.table).join() === 'kategori,produk,item');
  check(`${tag}: row counts`, (await v(`SELECT COUNT(*) FROM ${T('kategori')}`)) === 25 && (await v(`SELECT COUNT(*) FROM ${T('produk')}`)) === 200 && (await v(`SELECT COUNT(*) FROM ${T('item')}`)) === 300);
  check(`${tag}: FK integrity`, (await v(`SELECT COUNT(*) FROM ${T('produk')} p WHERE p.kategori_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${T('kategori')} k WHERE k.id = p.kategori_id)`)) === 0);
  check(`${tag}: unique respected`, (await v(`SELECT COUNT(DISTINCT sku) FROM ${T('produk')}`)) === 200 && (await v(`SELECT COUNT(DISTINCT nama) FROM ${T('kategori')}`)) === 25);
  check(`${tag}: sequence generator`, (await db.raw(env.conn, `SELECT MIN(sku) FROM ${T('produk')}`, [], env.ns)).rows[0][0] === 'SKU-00001');
  const r2 = await job((ctx) => runGenerate(ctx, { conn: env.conn, ns: env.ns, tables: [{ table: 'kategori', rows: 5, mode: 'append' }] }));
  check(`${tag}: append keeps unique`, r2.status === 'done' && (await v(`SELECT COUNT(DISTINCT nama) FROM ${T('kategori')}`)) === 30, r2.error || '');
  const r3 = await job((ctx) => runGenerate(ctx, { conn: env.conn, ns: env.ns, tables: [{ table: 'item', rows: 50, mode: 'replace' }] }));
  check(`${tag}: replace mode`, r3.status === 'done' && (await v(`SELECT COUNT(*) FROM ${T('item')}`)) === 50, r3.error || '');
  await E.drop('gen');
}

async function suiteFindDictBackup(E) {
  const tag = E.type;
  const env = await E.make('fdb');
  await seed(env);
  let j = await job((ctx) => runFind(ctx, { conn: env.conn, ns: env.ns, term: 'botol' }));
  const hit = j.result?.results.find((r) => r.table === 'produk');
  check(`find ${tag}: case-insensitive contains`, j.status === 'done' && hit?.count === 1 && hit.matched.includes('nama'), j.error || JSON.stringify(j.result?.results.map((r) => [r.table, r.count])));
  j = await job((ctx) => runFind(ctx, { conn: env.conn, ns: env.ns, term: '100%', match: 'contains' }));
  check(`find ${tag}: LIKE wildcards escaped`, j.status === 'done' && j.result.hits === 0, j.error || '');
  j = await job((ctx) => runFind(ctx, { conn: env.conn, ns: env.ns, term: 'A1', match: 'exact' }));
  check(`find ${tag}: exact`, j.status === 'done' && j.result.results.find((r) => r.table === 'produk')?.count === 1);

  const html = await buildDictionary(env.conn, env.ns, {});
  check(`dictionary ${tag}: html`, html.ext === 'html' && html.content.includes('id="t-produk"') && /FK → kategori\.id/.test(html.content) && html.content.includes('Nama produk') === (E.type !== 'sqlite'));
  const md = await buildDictionary(env.conn, env.ns, { format: 'md' });
  check(`dictionary ${tag}: markdown`, md.content.includes('## produk') && md.content.includes('| `sku` |'));

  process.env.DBSTUDIO_DATA_DIR = mkdtempSync(join(tmpdir(), 'dbst-bk-'));
  const bk = await import('../lib/backup.js');
  const b = await job((ctx) => bk.runBackup(ctx, { conn: env.conn, ns: env.ns, note: 'uji' }));
  const list = bk.listBackups(env.conn.id);
  check(`backup ${tag}: created`, b.status === 'done' && list.length >= 1 && list[0].note === 'uji' && list[0].size > 100, b.error || '');
  await db.raw(env.conn, `DELETE FROM ${Q(env.conn, env.ns, 'item')}`, [], env.ns);
  const rs = await job((ctx) => bk.runRestore(ctx, { conn: env.conn, ns: env.ns, backupId: b.result.id }));
  check(`restore ${tag}`, rs.status === 'done', rs.error || '');
  if (rs.status === 'done') await verifyData(`restore ${tag}`, env);
  bk.deleteBackup(env.conn.id, b.result.id);
  check(`backup ${tag}: delete`, bk.listBackups(env.conn.id).every((x) => x.id !== b.result.id));
  rmSync(process.env.DBSTUDIO_DATA_DIR, { recursive: true, force: true });
  delete process.env.DBSTUDIO_DATA_DIR;
  await E.drop('fdb');
}

async function suiteXlsx() {
  console.log('\nExcel');
  const buf = buildXlsx(['id', 'nama', 'harga', 'catatan'], [[1, 'Kopi & "Teh" <spesial>', '15000.50', null], [2, 'Ünïcødé 🍚', 7, 'baris\nbaru'], [3, '007', true, { a: 1 }]], 'Produk');
  const f = join(tmpdir(), `dbst_${stamp}.xlsx`);
  writeFileSync(f, buf);
  let ok = false;
  let listing = '';
  try {
    listing = execFileSync('unzip', ['-l', f]).toString();
    execFileSync('unzip', ['-tq', f]);
    ok = true;
  } catch (e) {
    listing = e.message;
  }
  check('xlsx: valid zip', ok && listing.includes('xl/worksheets/sheet1.xml'));
  const sheet = execFileSync('unzip', ['-p', f, 'xl/worksheets/sheet1.xml']).toString();
  check('xlsx: escaping + numbers', sheet.includes('Kopi &amp; &quot;Teh&quot; &lt;spesial&gt;') && sheet.includes('<v>15000.50</v>') && sheet.includes('t="inlineStr"><is><t xml:space="preserve">007</t>'));
  rmSync(f, { force: true });
}

// Language switching: English by default, Indonesian from public/js/locales/id.js once settings say so.
// Runs in its own data dir so the user's ~/.dbstudio/settings.json is never read or changed.
async function suiteI18n() {
  console.log('\nLanguage (i18n)');
  const prevDir = process.env.DBSTUDIO_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'dbst-i18n-'));
  process.env.DBSTUDIO_DATA_DIR = dir;
  // Only keys present in the dictionary can be checked strictly (id.js is filled when the fragments are merged).
  const idOf = (k) => ID[k] ?? k;
  let started = null;
  try {
    check('i18n: default language is en', settings.get().language === 'en' && lang() === 'en' && locale() === 'en-US');
    check('i18n: English by default', t('Settings') === 'Settings' && t('Job not found') === 'Job not found');
    check('i18n: placeholders', t('Restore into {name}', { name: 'db1' }) === 'Restore into db1');
    check('i18n: plural + locale number', plural(1, '{n} row', '{n} rows') === '1 row' && plural(1234, '{n} row', '{n} rows') === '1,234 rows', plural(1234, '{n} row', '{n} rows'));
    check('i18n: datagen labels in English', generatorList().fullName === 'Full name');

    let threw = false;
    try { settings.set({ language: 'xx' }); } catch { threw = true; }
    check('settings: unknown language rejected', threw && settings.get().language === 'en');
    threw = false;
    try { settings.set({ theme: 'neon' }); } catch { threw = true; }
    check('settings: unknown theme rejected', threw);

    // A broken / foreign settings file falls back to the defaults.
    const other = mkdtempSync(join(tmpdir(), 'dbst-i18n-'));
    writeFileSync(join(other, 'settings.json'), JSON.stringify({ language: 'fr', theme: 'neon' }));
    process.env.DBSTUDIO_DATA_DIR = other;
    check('settings: invalid saved values sanitized', settings.get().language === 'en' && settings.get().theme === null);
    rmSync(other, { recursive: true, force: true });
    process.env.DBSTUDIO_DATA_DIR = dir;

    // The HTTP endpoints the UI uses (server on a random loopback port).
    const { startServer, stopServer } = await import('../server.js');
    started = await startServer({ port: 0 });
    const base = `http://127.0.0.1:${started.port}`;
    const api = (method, path, body) =>
      fetch(base + path, { method, headers: { 'X-DBStudio': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const g = await (await api('GET', '/api/settings')).json();
    check('GET /api/settings defaults to en', g.language === 'en' && g.dataDir === dir, JSON.stringify(g));
    const bad = await api('POST', '/api/settings', { language: 'xx' });
    check('POST /api/settings rejects unknown language', bad.status === 400);
    const ok = await (await api('POST', '/api/settings', { language: 'id' })).json();
    check('POST /api/settings saves the language', ok.language === 'id' && JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).language === 'id');
    const page = await (await fetch(base + '/')).text();
    check('index.html stamped with the saved language', page.includes('<html lang="id"'));
    const nf = await (await api('GET', '/api/jobs/nope')).json();
    check('server errors follow the language', nf.error === idOf('Job not found'), nf.error);
    await stopServer(started.server);
    started = null;

    check('i18n: language switch applies at once', lang() === 'id' && locale() === 'id-ID');
    if ('Settings' in ID) check('i18n: Indonesian dictionary (Settings → Pengaturan)', t('Settings') === 'Pengaturan', t('Settings'));
    else console.log('  (info) locales/id.js has no "Settings" key yet — Indonesian text check skipped');
    check('i18n: Indonesian placeholders', t('Restore into {name}', { name: 'db1' }) === idOf('Restore into {name}').replace('{name}', 'db1'));
    check('i18n: Indonesian number format', plural(1234, '{n} row', '{n} rows') === idOf('{n} rows').replace('{n}', '1.234'), plural(1234, '{n} row', '{n} rows'));
    check('i18n: datagen labels translated when served', generatorList().fullName === idOf('Full name'));
    let err = null;
    try { connio.parseImport({ content: connio.exportConnections([{ name: 'x', type: 'sqlite', file: '/x.db' }], { passphrase: 'p' }) }); } catch (e) { err = e; }
    check('i18n: error codes unchanged, message translated', err?.code === 'NEED_PASSPHRASE' && err.message === idOf('This file is encrypted. Enter the passphrase.'), err?.message);
    const j = await job(() => { throw new Error('x'); });
    check('i18n: job phase translated', j.phase === idOf('Failed'), j.phase);

    settings.set({ language: 'en' });
    check('i18n: back to English', t('Job not found') === 'Job not found' && generatorList().fullName === 'Full name');
  } finally {
    if (started) await (await import('../server.js')).stopServer(started.server).catch(() => {});
    if (prevDir === undefined) delete process.env.DBSTUDIO_DATA_DIR;
    else process.env.DBSTUDIO_DATA_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- run
const pick = (name) => !only.length || only.includes(name);
try {
  if (pick('split')) await suiteSplit();
  for (const E of engines) {
    if (!pick('engine')) break;
    try {
      await suiteEngine(E);
    } catch (e) {
      check(`${E.label} suite`, false, e.stack);
    } finally {
      await E.drop('src');
    }
  }
  if (pick('copy')) {
    console.log('\nCopy across engines');
    for (const a of engines) {
      for (const b of engines) {
        try {
          await suiteCopy(a, b);
        } catch (e) {
          check(`copy ${a.type}→${b.type}`, false, e.stack);
        }
      }
    }
  }
  if (pick('dump')) {
    console.log('\nDump → import across dialects');
    for (const a of engines) {
      for (const b of engines) {
        try {
          await suiteDump(a, b);
        } catch (e) {
          check(`dump ${a.type}→${b.type}`, false, e.stack);
        }
      }
    }
  }
  if (pick('connio')) await suiteConnio();
  if (pick('xlsx')) await suiteXlsx();
  if (pick('datasync')) {
    console.log('\nData sync across engines');
    for (const a of engines) for (const b of engines) {
      try { await suiteDataSync(a, b); } catch (e) { check(`datasync ${a.type}→${b.type}`, false, e.stack); }
    }
  }
  if (pick('datagen')) {
    console.log('\nData generator');
    for (const E of engines) { try { await suiteDataGen(E); } catch (e) { check(`datagen ${E.type}`, false, e.stack); } }
  }
  if (pick('tools')) {
    console.log('\nFind, data dictionary, backup & restore');
    for (const E of engines) { try { await suiteFindDictBackup(E); } catch (e) { check(`tools ${E.type}`, false, e.stack); } }
  }
  if (pick('i18n')) {
    try { await suiteI18n(); } catch (e) { check('i18n suite', false, e.stack); }
  }
} finally {
  await db.shutdown();
  for (const f of sqliteFiles) rmSync(f, { force: true });
}
console.log(`\n${passes} passed, ${failures} failed  (engines: ${engines.map((e) => e.label).join(', ')})`);
process.exit(failures ? 1 : 0);
