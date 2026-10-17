// Unified driver layer for MySQL/MariaDB, PostgreSQL and SQLite.
// Every engine exposes the same operations so the UI never branches on type
// except for labels ("database" vs "schema").
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { openTunnel } from './ssh.js';
import { t } from './i18n.js';

// Return dates/timestamps exactly as the server sends them instead of
// converting to JS Date (which shifts time zones and loses precision).
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, (v) => v);

const live = new Map(); // connection id -> { type, handle, tunnel, info }

export const NAMESPACE_LABEL = { mysql: 'database', postgres: 'schema', sqlite: 'database' };

// ---------- identifiers & params ----------

export function q(type, ident) {
  const s = String(ident);
  return type === 'mysql' ? '`' + s.replaceAll('`', '``') + '`' : '"' + s.replaceAll('"', '""') + '"';
}

export function qualified(type, ns, table) {
  if (type === 'sqlite' || !ns) return q(type, table);
  return q(type, ns) + '.' + q(type, table);
}

export function placeholder(type, i) {
  return type === 'postgres' ? '$' + i : '?';
}

// Make a JS value acceptable to each driver as a bound parameter.
export function normParam(type, v) {
  if (v === undefined) return null;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return type === 'postgres' ? v : v ? 1 : 0;
  if (v instanceof Uint8Array) return type === 'sqlite' ? v : Buffer.from(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v) && type === 'postgres') return v; // native pg arrays
  return JSON.stringify(v);
}

// ---------- connection lifecycle ----------

async function open(conn) {
  let tunnel = null;
  let host = conn.host || '127.0.0.1';
  let port = Number(conn.port) || (conn.type === 'mysql' ? 3306 : 5432);
  if (conn.ssh?.enabled && conn.type !== 'sqlite') {
    tunnel = await openTunnel(conn.ssh, host, port);
    host = '127.0.0.1';
    port = tunnel.port;
  }
  try {
    let handle;
    switch (conn.type) {
      case 'mysql':
        handle = mysql.createPool({
          host,
          port,
          user: conn.user,
          password: conn.password || undefined,
          database: conn.database || undefined,
          multipleStatements: true,
          dateStrings: true,
          supportBigNumbers: true,
          bigNumberStrings: true,
          connectTimeout: 10000,
          connectionLimit: 5,
          charset: 'utf8mb4',
          ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
        });
        break;
      case 'postgres':
        handle = new pg.Pool({
          host,
          port,
          user: conn.user,
          password: conn.password || undefined,
          database: conn.database || 'postgres',
          connectionTimeoutMillis: 10000,
          max: 5,
          ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
        });
        handle.on('error', () => {}); // idle client errors must not crash the server
        break;
      case 'sqlite':
        if (!conn.file) throw new Error(t('SQLite connection needs a file path'));
        handle = new DatabaseSync(conn.file);
        break;
      default:
        throw new Error(t('Unsupported database type: {type}', { type: conn.type }));
    }
    return { type: conn.type, handle, tunnel, info: null };
  } catch (err) {
    tunnel?.close();
    throw err;
  }
}

async function entryFor(conn) {
  let entry = live.get(conn.id);
  if (!entry) {
    entry = await open(conn);
    live.set(conn.id, entry);
    // If the SSH session drops, forget the pool so the next request reconnects.
    entry.tunnel?.onClose(() => {
      if (live.get(conn.id) === entry) disconnect(conn.id);
    });
  }
  return entry;
}

export async function disconnect(id) {
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  try {
    if (entry.type === 'sqlite') entry.handle.close();
    else await entry.handle.end();
  } catch {
    /* already closed */
  }
  entry.tunnel?.close();
}

export async function shutdown() {
  await Promise.all([...live.keys()].map(disconnect));
}

export async function test(conn) {
  const tmp = { ...conn, id: '__test__' + Date.now() + Math.random() };
  try {
    const info = await serverInfo(tmp);
    return { ok: true, version: info.version, flavor: info.flavor, tunnel: Boolean(conn.ssh?.enabled) };
  } finally {
    await disconnect(tmp.id);
  }
}

export async function serverInfo(conn) {
  const entry = await entryFor(conn);
  if (!entry.info) {
    const sql = conn.type === 'sqlite' ? 'SELECT sqlite_version()' : 'SELECT version()';
    const version = String((await raw(conn, sql)).rows[0]?.[0] ?? '');
    const flavor = conn.type === 'mysql' ? (/mariadb/i.test(version) ? 'mariadb' : 'mysql') : conn.type;
    entry.info = { version, flavor };
  }
  return entry.info;
}

// ---------- SQL splitting ----------

// Split a script into statements, honoring quotes, comments, MySQL DELIMITER lines and
// backslash escapes, PostgreSQL $tag$ bodies and SQLite CREATE TRIGGER ... END blocks.
export function splitStatements(sql, dialect = 'sqlite') {
  const out = [];
  let delim = ';';
  let cur = '';
  let i = 0;
  const n = sql.length;
  const push = () => {
    const s = cur.trim();
    const meaningful = s.replace(/\/\*(?!!)[\s\S]*?\*\//g, '').replace(/(^|\n)\s*(--|#)[^\n]*/g, '').trim();
    if (meaningful) out.push(s);
    cur = '';
  };

  while (i < n) {
    const ch = sql[i];
    const nx = sql[i + 1];

    if (dialect === 'mysql' && (i === 0 || sql[i - 1] === '\n')) {
      const m = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(\r?\n|$)/i.exec(sql.slice(i, i + 200));
      if (m) {
        push();
        delim = m[1];
        i += m[0].length;
        continue;
      }
    }
    // line comments
    if ((ch === '-' && nx === '-') || (ch === '#' && dialect === 'mysql')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // block comments (kept: MySQL /*! ... */ is executable)
    if (ch === '/' && nx === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // quoted strings / identifiers
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (dialect === 'mysql' && sql[j] === '\\' && ch !== '`') {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // PostgreSQL dollar quoting
    if (ch === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? n : end + m[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (sql.startsWith(delim, i)) {
      const inTrigger =
        dialect === 'sqlite' && /^\s*create\s+(temp\s+|temporary\s+)?trigger\b/i.test(cur) && !/\bend\s*$/i.test(cur);
      if (inTrigger) {
        cur += ch;
        i++;
        continue;
      }
      push();
      i += delim.length;
      continue;
    }
    cur += ch;
    i++;
  }
  push();
  return out;
}

const READ_KEYWORDS = new Set(['select', 'pragma', 'with', 'explain', 'values', 'show', 'describe', 'desc']);
const firstKeyword = (stmt) => (stmt.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').match(/^[\s(]*([a-zA-Z]+)/)?.[1] || '').toLowerCase();

// ---------- sessions: one dedicated connection with run/exec/transaction ----------

function mysqlSession(c) {
  const s = {
    async run(sql, params = []) {
      if (!params.length && /^[ \t]*DELIMITER\s/im.test(sql)) {
        const stmts = splitStatements(sql, 'mysql');
        let last = null;
        for (const st of stmts) last = await s.run(st);
        return { ...(last || { columns: [], rows: [], affected: 0, command: 'OK' }), statements: stmts.length };
      }
      const [res, fields] = await c.query({ sql, rowsAsArray: true }, params.map((p) => normParam('mysql', p)));
      const multi = Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined);
      let r = res;
      let f = fields;
      let statements = 1;
      if (multi) {
        statements = res.length;
        let pick = -1;
        for (let i = fields.length - 1; i >= 0; i--) {
          if (Array.isArray(fields[i])) {
            pick = i;
            break;
          }
        }
        if (pick === -1) pick = res.length - 1;
        r = res[pick];
        f = fields[pick];
      }
      return Array.isArray(r)
        ? { columns: (f || []).map((x) => x.name), rows: r, affected: null, command: 'SELECT', statements }
        : { columns: [], rows: [], affected: r.affectedRows, insertId: r.insertId || null, command: 'OK', statements };
    },
    async exec(sql, params = []) {
      const [r] = await c.query(sql, params.map((p) => normParam('mysql', p)));
      return Array.isArray(r) ? r.length : r.affectedRows;
    },
    begin: () => c.beginTransaction(),
    commit: () => c.commit(),
    rollback: () => c.rollback(),
  };
  return s;
}

function pgSession(c) {
  return {
    async run(sql, params = []) {
      let res = await c.query({ text: sql, values: params.length ? params.map((p) => normParam('postgres', p)) : undefined, rowMode: 'array' });
      let statements = 1;
      if (Array.isArray(res)) {
        statements = res.length;
        res = [...res].reverse().find((x) => x.fields && x.fields.length) || res[res.length - 1];
      }
      const hasRows = res.fields && res.fields.length > 0;
      return {
        columns: hasRows ? res.fields.map((x) => x.name) : [],
        rows: hasRows ? res.rows : [],
        affected: hasRows ? null : res.rowCount,
        command: res.command || 'OK',
        statements,
      };
    },
    async exec(sql, params = []) {
      return (await c.query(sql, params.map((p) => normParam('postgres', p)))).rowCount ?? 0;
    },
    begin: () => c.query('BEGIN'),
    commit: () => c.query('COMMIT'),
    rollback: () => c.query('ROLLBACK'),
  };
}

function sqliteSession(db) {
  return {
    async run(sql, params = []) {
      const stmts = params.length ? [sql] : splitStatements(sql, 'sqlite');
      if (!stmts.length) throw new Error(t('Empty query'));
      for (let i = 0; i < stmts.length - 1; i++) db.exec(stmts[i]);
      const last = stmts[stmts.length - 1];
      const stmt = db.prepare(last);
      const ps = params.map((p) => normParam('sqlite', p));
      if (READ_KEYWORDS.has(firstKeyword(last)) || /\breturning\b/i.test(last)) {
        let rows;
        let columns;
        try {
          stmt.setReturnArrays(true);
          rows = stmt.all(...ps);
          columns = stmt.columns().map((c) => c.name);
        } catch {
          const objs = stmt.all(...ps);
          columns = objs.length ? Object.keys(objs[0]) : [];
          rows = objs.map((o) => Object.values(o));
        }
        return { columns, rows, affected: null, command: 'SELECT', statements: stmts.length };
      }
      const r = stmt.run(...ps);
      return {
        columns: [],
        rows: [],
        affected: Number(r.changes),
        insertId: r.lastInsertRowid != null ? String(r.lastInsertRowid) : null,
        command: 'OK',
        statements: stmts.length,
      };
    },
    async exec(sql, params = []) {
      if (!params.length && splitStatements(sql, 'sqlite').length > 1) {
        db.exec(sql);
        return 0;
      }
      return Number(db.prepare(sql).run(...params.map((p) => normParam('sqlite', p))).changes);
    },
    begin: async () => db.exec('BEGIN'),
    commit: async () => db.exec('COMMIT'),
    rollback: async () => {
      if (db.isTransaction !== false) db.exec('ROLLBACK');
    },
  };
}

export async function withSession(conn, ns, fn) {
  const { handle } = await entryFor(conn);
  if (conn.type === 'mysql') {
    const c = await handle.getConnection();
    try {
      if (ns) await c.query('USE ' + q('mysql', ns));
      return await fn(mysqlSession(c));
    } finally {
      c.release();
    }
  }
  if (conn.type === 'postgres') {
    const c = await handle.connect();
    try {
      if (ns) await c.query(`SET search_path TO ${q('postgres', ns)}, public`);
      return await fn(pgSession(c));
    } finally {
      c.release();
    }
  }
  return fn(sqliteSession(handle));
}

export function transaction(conn, ns, fn) {
  return withSession(conn, ns, async (s) => {
    await s.begin();
    try {
      const out = await fn(s);
      await s.commit();
      return out;
    } catch (err) {
      await s.rollback().catch(() => {});
      throw err;
    }
  });
}

export async function raw(conn, sql, params = [], ns = null) {
  const started = performance.now();
  const result = await withSession(conn, ns, (s) => s.run(sql, params));
  result.ms = Math.round(performance.now() - started);
  return result;
}

// Map array rows to objects for internal metadata queries.
export async function objects(conn, sql, params = [], ns = null) {
  const r = await raw(conn, sql, params, ns);
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/**
 * Run a list of statements in order. PostgreSQL and SQLite can wrap DDL in a transaction;
 * MySQL commits DDL implicitly, so there it runs statement by statement.
 * Returns { done, errors: [{index, sql, error}] }.
 */
export async function execScript(conn, ns, statements, { transactional = conn.type !== 'mysql', continueOnError = false, onProgress } = {}) {
  const errors = [];
  let done = 0;
  const runAll = async (s) => {
    for (let i = 0; i < statements.length; i++) {
      try {
        await s.run(statements[i]);
        done++;
      } catch (e) {
        errors.push({ index: i, sql: statements[i].slice(0, 500), error: e.message });
        if (!continueOnError) throw Object.assign(e, { failedIndex: i, failedSql: statements[i] });
      }
      onProgress?.(i + 1, statements.length);
    }
  };
  // SQLite PRAGMA foreign_keys / scripts that manage their own BEGIN must run outside a transaction.
  const selfManaged = statements.some((s) => /^\s*(BEGIN|COMMIT|PRAGMA\s+foreign_keys)\b/i.test(s));
  if (transactional && !continueOnError && !selfManaged) await transaction(conn, ns, runAll);
  else {
    await withSession(conn, ns, async (s) => {
      try {
        await runAll(s);
      } catch (err) {
        if (selfManaged && conn.type === 'sqlite') {
          await s.run('ROLLBACK').catch(() => {});
          await s.run('PRAGMA foreign_keys = ON').catch(() => {});
        }
        throw err;
      }
    });
  }
  return { done, errors };
}

// ---------- metadata ----------

export async function listNamespaces(conn) {
  if (conn.type === 'mysql') {
    return (await objects(conn, 'SHOW DATABASES')).map((r) => Object.values(r)[0]);
  }
  if (conn.type === 'postgres') {
    const rows = await objects(
      conn,
      `SELECT schema_name AS name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema') AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%'
       ORDER BY schema_name`,
    );
    return rows.map((r) => r.name);
  }
  return ['main'];
}

export async function listTables(conn, ns) {
  if (conn.type === 'mysql') {
    return objects(
      conn,
      `SELECT TABLE_NAME AS name, IF(TABLE_TYPE='VIEW','view','table') AS kind, TABLE_ROWS AS approxRows
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [ns],
    );
  }
  if (conn.type === 'postgres') {
    return objects(
      conn,
      `SELECT c.relname AS name, CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "approxRows"
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
      [ns],
    );
  }
  return objects(
    conn,
    `SELECT name, type AS kind, NULL AS approxRows FROM sqlite_master
     WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
}

export async function listColumns(conn, ns, table) {
  if (conn.type === 'mysql') {
    const rows = await objects(
      conn,
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
              COLUMN_KEY AS ckey, EXTRA AS extra
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [ns, table],
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.nullable === 'YES',
      default: r.dflt,
      pk: r.ckey === 'PRI',
      extra: r.extra || '',
    }));
  }
  if (conn.type === 'postgres') {
    const [cols, pks] = await Promise.all([
      objects(
        conn,
        `SELECT column_name AS name,
                CASE WHEN data_type = 'USER-DEFINED' THEN udt_name
                     WHEN character_maximum_length IS NOT NULL THEN data_type || '(' || character_maximum_length || ')'
                     ELSE data_type END AS type,
                is_nullable AS nullable, column_default AS dflt, is_identity AS ident
         FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [ns, table],
      ),
      objects(
        conn,
        `SELECT kcu.column_name AS name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
        [ns, table],
      ),
    ]);
    const pkSet = new Set(pks.map((p) => p.name));
    return cols.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.nullable === 'YES',
      default: r.dflt,
      pk: pkSet.has(r.name),
      extra: r.ident === 'YES' || (r.dflt && String(r.dflt).startsWith('nextval(')) ? 'auto_increment' : '',
    }));
  }
  const rows = await objects(conn, `SELECT * FROM pragma_table_info(?)`, [table]);
  return rows.map((r) => ({
    name: r.name,
    type: r.type || '',
    nullable: !r.notnull,
    default: r.dflt_value,
    pk: Number(r.pk) > 0,
    extra: '',
  }));
}

// { table: [column, ...] } for the whole namespace in one round trip — feeds autocomplete.
export async function allColumns(conn, ns) {
  let rows;
  if (conn.type === 'mysql') {
    rows = await objects(
      conn,
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [ns],
    );
  } else if (conn.type === 'postgres') {
    rows = await objects(
      conn,
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [ns],
    );
  } else {
    rows = await objects(
      conn,
      `SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p
       WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`,
    );
  }
  const out = {};
  for (const r of rows) (out[r.t] ||= []).push(r.c);
  return out;
}

// ---------- routines, triggers, events ----------

export async function listObjects(conn, ns) {
  if (conn.type === 'mysql') {
    const [routines, triggers, events] = await Promise.all([
      objects(conn, `SELECT ROUTINE_NAME AS name, LOWER(ROUTINE_TYPE) AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY 1`, [ns]),
      objects(
        conn,
        `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION) AS info
         FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY 1`,
        [ns],
      ),
      objects(conn, `SELECT EVENT_NAME AS name, STATUS AS info FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY 1`, [ns]).catch(() => []),
    ]);
    return { routines, triggers, events };
  }
  if (conn.type === 'postgres') {
    const [routines, triggers] = await Promise.all([
      objects(
        conn,
        `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name, p.oid::text AS id,
                CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind IN ('f','p')
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         ORDER BY 1`,
        [ns],
      ),
      objects(
        conn,
        `SELECT t.tgname AS name, c.relname AS tbl, t.oid::text AS id FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1`,
        [ns],
      ),
    ]);
    return { routines, triggers, events: [] };
  }
  const triggers = await objects(conn, `SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'trigger' ORDER BY 1`);
  return { routines: [], triggers, events: [] };
}

export async function objectDefinition(conn, ns, kind, name, id) {
  const ty = conn.type;
  if (ty === 'mysql') {
    const what = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT', view: 'VIEW' }[kind];
    if (!what) throw new Error(t('Unknown object kind'));
    const r = await raw(conn, `SHOW CREATE ${what} ${qualified('mysql', ns, name)}`);
    const idx = r.columns.findIndex((c) => /^(Create|SQL Original Statement)/i.test(c) && !/character|collation/i.test(c));
    return String(r.rows[0]?.[idx] ?? '');
  }
  if (ty === 'postgres') {
    if (kind === 'function' || kind === 'procedure') {
      return String((await raw(conn, 'SELECT pg_get_functiondef($1::oid)', [id])).rows[0][0]);
    }
    if (kind === 'trigger') return String((await raw(conn, 'SELECT pg_get_triggerdef($1::oid, true)', [id])).rows[0][0]) + ';';
    if (kind === 'view') {
      const def = (await raw(conn, 'SELECT pg_get_viewdef($1::regclass, true)', [qualified('postgres', ns, name)])).rows[0][0];
      return `CREATE OR REPLACE VIEW ${qualified('postgres', ns, name)} AS\n${def}`;
    }
    throw new Error(t('Unknown object kind'));
  }
  const r = await objects(conn, `SELECT sql FROM sqlite_master WHERE name = ?`, [name]);
  return (r[0]?.sql ?? '') + ';';
}

// ---------- table data + row editing ----------

export async function tableData(conn, ns, table, { limit = 100, offset = 0, orderBy = null, dir = 'asc', filter = '' } = {}) {
  const cols = await listColumns(conn, ns, table);
  const names = new Set(cols.map((c) => c.name));
  const from = qualified(conn.type, ns, table);
  const where = filter && filter.trim() ? ` WHERE ${filter}` : '';
  const order = orderBy && names.has(orderBy) ? ` ORDER BY ${q(conn.type, orderBy)} ${dir === 'desc' ? 'DESC' : 'ASC'}` : '';
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const off = Math.max(Number(offset) || 0, 0);
  const data = await raw(conn, `SELECT * FROM ${from}${where}${order} LIMIT ${lim} OFFSET ${off}`, [], ns);
  const count = await raw(conn, `SELECT COUNT(*) FROM ${from}${where}`, [], ns);
  return { ...data, columnsMeta: cols, total: Number(count.rows[0]?.[0] ?? 0), limit: lim, offset: off };
}

function whereFromKey(type, key, startIndex) {
  const parts = [];
  const values = [];
  let i = startIndex;
  for (const [col, val] of Object.entries(key)) {
    if (val === null) parts.push(`${q(type, col)} IS NULL`);
    else {
      parts.push(`${q(type, col)} = ${placeholder(type, i++)}`);
      values.push(val);
    }
  }
  if (!parts.length) throw new Error(t('Empty row key; refusing to change every row'));
  return { sql: parts.join(' AND '), values, next: i };
}

// Apply staged grid edits all-or-nothing.
// ops: [{ type: 'update', key, changes } | { type: 'delete', key } | { type: 'insert', values }]
// key = original primary-key values of the row, so edits to the PK itself still target the right row.
export async function applyChanges(conn, ns, table, ops) {
  if (!Array.isArray(ops) || !ops.length) return { applied: 0, affected: 0 };
  const names = new Set((await listColumns(conn, ns, table)).map((c) => c.name));
  const check = (obj) => {
    for (const k of Object.keys(obj || {})) if (!names.has(k)) throw new Error(t('Unknown column: {name}', { name: k }));
  };
  const ty = conn.type;
  const target = qualified(ty, ns, table);
  const one = ty === 'mysql' ? ' LIMIT 1' : '';

  const statements = ops.map((op) => {
    if (op.type === 'delete') {
      check(op.key);
      const w = whereFromKey(ty, op.key, 1);
      return { sql: `DELETE FROM ${target} WHERE ${w.sql}${one}`, params: w.values, expectRow: true };
    }
    if (op.type === 'update') {
      check(op.key);
      check(op.changes);
      const entries = Object.entries(op.changes || {});
      if (!entries.length) throw new Error(t('Update without changes'));
      const sets = entries.map(([col], i) => `${q(ty, col)} = ${placeholder(ty, i + 1)}`);
      const w = whereFromKey(ty, op.key, entries.length + 1);
      return {
        sql: `UPDATE ${target} SET ${sets.join(', ')} WHERE ${w.sql}${one}`,
        params: [...entries.map(([, v]) => v), ...w.values],
        expectRow: true,
      };
    }
    if (op.type === 'insert') {
      check(op.values);
      const cols = Object.keys(op.values || {});
      if (!cols.length) {
        return { sql: ty === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES`, params: [] };
      }
      const ph = cols.map((_, i) => placeholder(ty, i + 1));
      return {
        sql: `INSERT INTO ${target} (${cols.map((c) => q(ty, c)).join(', ')}) VALUES (${ph.join(', ')})`,
        params: Object.values(op.values),
      };
    }
    throw new Error(t('Unknown change type: {type}', { type: op.type }));
  });

  return transaction(conn, ns, async (s) => {
    let affected = 0;
    for (const st of statements) {
      const n = await s.exec(st.sql, st.params);
      if (st.expectRow && n === 0) {
        throw new Error(t('Some rows were not found (changed or deleted elsewhere?). Nothing was saved.'));
      }
      affected += n;
    }
    return { applied: statements.length, affected };
  });
}

// Multi-row INSERT in batches inside the given session (used by copy and CSV import).
export async function insertRows(session, type, ns, table, columns, rows) {
  if (!rows.length) return 0;
  const perRow = columns.length || 1;
  const batch = Math.max(1, Math.min(500, Math.floor(30000 / perRow)));
  const target = qualified(type, ns, table);
  const colSql = columns.map((c) => q(type, c)).join(', ');
  let n = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    let p = 1;
    const values = chunk.map(() => '(' + columns.map(() => placeholder(type, p++)).join(', ') + ')').join(', ');
    n += await session.exec(`INSERT INTO ${target} (${colSql}) VALUES ${values}`, chunk.flat());
  }
  return n;
}

export async function bulkInsert(conn, ns, table, columns, rows) {
  const names = new Set((await listColumns(conn, ns, table)).map((c) => c.name));
  for (const c of columns) if (!names.has(c)) throw new Error(t('Unknown column: {name}', { name: c }));
  return transaction(conn, ns, (s) => insertRows(s, conn.type, ns, table, columns, rows));
}

// ---------- server tools ----------

function unsupported() {
  return Object.assign(new Error(t('Not available for SQLite')), { code: 'UNSUPPORTED' });
}

export async function processList(conn) {
  if (conn.type === 'mysql') {
    return raw(
      conn,
      `SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time, STATE AS state, LEFT(INFO, 2000) AS query
       FROM information_schema.PROCESSLIST ORDER BY TIME DESC`,
    );
  }
  if (conn.type === 'postgres') {
    return raw(
      conn,
      `SELECT pid AS id, usename AS user, client_addr::text AS host, datname AS db, state AS command,
              EXTRACT(EPOCH FROM (now() - query_start))::int AS time, wait_event AS state, left(query, 2000) AS query
       FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY time DESC NULLS LAST`,
    );
  }
  throw unsupported();
}

export async function killProcess(conn, id, mode = 'query') {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) throw new Error(t('Invalid process ID'));
  if (conn.type === 'mysql') return raw(conn, `KILL ${mode === 'connection' ? '' : 'QUERY '}${n}`);
  if (conn.type === 'postgres') return raw(conn, `SELECT ${mode === 'connection' ? 'pg_terminate_backend' : 'pg_cancel_backend'}($1)`, [n]);
  throw unsupported();
}

export async function serverVariables(conn) {
  if (conn.type === 'mysql') return raw(conn, 'SHOW GLOBAL VARIABLES');
  if (conn.type === 'postgres') {
    return raw(conn, `SELECT name AS "Variable", setting || COALESCE(' ' || unit, '') AS "Value", short_desc AS "Description" FROM pg_settings ORDER BY name`);
  }
  const pragmas = ['foreign_keys', 'journal_mode', 'synchronous', 'page_size', 'cache_size', 'auto_vacuum', 'encoding', 'user_version', 'application_id', 'busy_timeout'];
  const rows = [];
  for (const p of pragmas) rows.push([p, String((await raw(conn, `PRAGMA ${p}`)).rows[0]?.[0] ?? '')]);
  for (const r of (await raw(conn, 'PRAGMA compile_options')).rows) rows.push(['compile_option', String(r[0])]);
  return { columns: ['Variable', 'Value'], rows };
}

export async function serverStatus(conn) {
  if (conn.type === 'mysql') return raw(conn, 'SHOW GLOBAL STATUS');
  if (conn.type === 'postgres') {
    const r = await objects(
      conn,
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size, d.* FROM pg_stat_database d WHERE datname = current_database()`,
    );
    return { columns: ['Variable', 'Value'], rows: Object.entries(r[0] || {}).map(([k, v]) => [k, v == null ? null : String(v)]) };
  }
  const val = async (p) => (await raw(conn, `PRAGMA ${p}`)).rows[0]?.[0];
  const rows = [
    ['page_count', String(await val('page_count'))],
    ['freelist_count', String(await val('freelist_count'))],
  ];
  try {
    rows.unshift(['file_size_bytes', String(statSync(conn.file).size)]);
  } catch {
    /* in-memory or missing */
  }
  return { columns: ['Variable', 'Value'], rows };
}

export async function listUsers(conn) {
  if (conn.type === 'mysql') return raw(conn, 'SELECT User AS user, Host AS host FROM mysql.user ORDER BY User, Host');
  if (conn.type === 'postgres') {
    return raw(
      conn,
      `SELECT rolname AS user, rolsuper AS superuser, rolcreatedb AS createdb, rolcreaterole AS createrole, rolcanlogin AS login
       FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`,
    );
  }
  throw unsupported();
}

export async function userGrants(conn, user, host) {
  if (conn.type === 'mysql') {
    const r = await raw(conn, 'SHOW GRANTS FOR ?@?', [user, host || '%']);
    return r.rows.map((x) => String(x[0]));
  }
  if (conn.type === 'postgres') {
    const r = await raw(
      conn,
      `SELECT format('GRANT %s ON %I.%I TO %I;', string_agg(privilege_type, ', ' ORDER BY privilege_type), table_schema, table_name, grantee)
       FROM information_schema.role_table_grants WHERE grantee = $1 GROUP BY table_schema, table_name, grantee ORDER BY 1`,
      [user],
    );
    const m = await raw(conn, `SELECT format('GRANT %I TO %I;', b.rolname, $1::text) FROM pg_auth_members am JOIN pg_roles b ON b.oid = am.roleid JOIN pg_roles r ON r.oid = am.member WHERE r.rolname = $1`, [user]);
    return [...m.rows, ...r.rows].map((x) => String(x[0]));
  }
  throw unsupported();
}

export async function charsets(conn) {
  if (conn.type !== 'mysql') return { charsets: [], collations: [] };
  const [cs, co] = await Promise.all([
    objects(conn, 'SELECT CHARACTER_SET_NAME AS name, DEFAULT_COLLATE_NAME AS def FROM information_schema.CHARACTER_SETS ORDER BY 1'),
    objects(conn, 'SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS cs FROM information_schema.COLLATIONS ORDER BY 1'),
  ]);
  return { charsets: cs, collations: co };
}
