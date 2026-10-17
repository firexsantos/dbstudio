// Schema introspection and DDL generation for MySQL/MariaDB, PostgreSQL and SQLite.
//
// A table is described by a dialect-neutral model:
//   { name, kind: 'table'|'view', comment, engine, collation, rowsEstimate, definition (views),
//     columns: [{ name, type, nullable, default, autoIncrement, onUpdateNow, comment, generated }],
//     primaryKey: [col], primaryKeyName,
//     indexes: [{ name, columns, unique, constraint?, complex?, def? }],
//     foreignKeys: [{ name, columns, refNs, refTable, refColumns, onUpdate, onDelete }] }
// `default` is always an SQL expression in the source dialect (string literals are quoted).
import { q, qualified, objects, raw, serverInfo } from './drivers.js';
import { t } from './i18n.js';

const PG_RULE = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const RULES = new Set(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);

const newModel = (name, kind, extra = {}) => ({
  name,
  kind,
  comment: '',
  columns: [],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  ...extra,
});

function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// ======================================================================
// Introspection
// ======================================================================

function mysqlDefault(d, extra, maria) {
  if (d == null) return null;
  d = String(d);
  if (maria) return d === 'NULL' ? null : d; // MariaDB already returns SQL expressions
  if (/DEFAULT_GENERATED/i.test(extra || '')) return /^current_timestamp/i.test(d) || d.startsWith('(') ? d : `(${d})`;
  if (/^current_timestamp(\(\d*\))?$/i.test(d)) return d;
  if (/^-?\d+(\.\d+)?$/.test(d)) return d;
  return `'${d.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

async function describeMysql(conn, ns, only) {
  const maria = (await serverInfo(conn)).flavor === 'mariadb';
  const f = (col) => (only ? ` AND ${col} IN (${only.map(() => '?').join(',')})` : '');
  const p = only ? [ns, ...only] : [ns];
  const [tables, cols, idx, fks, views] = await Promise.all([
    objects(
      conn,
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COMMENT AS comment, TABLE_ROWS AS rowsEst,
              TABLE_COLLATION AS coll
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?${f('TABLE_NAME')} ORDER BY TABLE_NAME`,
      p,
    ),
    objects(
      conn,
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
              EXTRA AS extra, COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS gen
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?${f('TABLE_NAME')} ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      p,
    ),
    objects(
      conn,
      `SELECT TABLE_NAME AS t, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, SUB_PART AS sub
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?${f('TABLE_NAME')} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      p,
    ),
    objects(
      conn,
      `SELECT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refNs,
              k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol, r.UPDATE_RULE AS upd, r.DELETE_RULE AS del
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ?${f('k.TABLE_NAME')} AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      p,
    ),
    objects(conn, `SELECT TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?${f('TABLE_NAME')}`, p),
  ]);

  const models = new Map();
  for (const t of tables) {
    models.set(
      t.name,
      newModel(t.name, t.type === 'VIEW' ? 'view' : 'table', {
        engine: t.engine || null,
        collation: t.coll || null,
        comment: t.comment || '',
        rowsEstimate: t.rowsEst == null ? null : Number(t.rowsEst),
      }),
    );
  }
  for (const c of cols) {
    const m = models.get(c.t);
    if (!m) continue;
    const gen = c.gen && /GENERATED/i.test(c.extra || '') ? { expr: c.gen, stored: /STORED/i.test(c.extra) } : null;
    m.columns.push({
      name: c.name,
      type: c.type,
      nullable: c.nullable === 'YES',
      default: gen ? null : mysqlDefault(c.dflt, c.extra, maria),
      autoIncrement: /auto_increment/i.test(c.extra || ''),
      onUpdateNow: /on update current_timestamp/i.test(c.extra || ''),
      comment: c.comment || '',
      generated: gen,
    });
  }
  for (const [key, rows] of group(idx, (r) => r.t + '\u0000' + r.name)) {
    const m = models.get(rows[0].t);
    if (!m) continue;
    const columns = rows.map((r) => r.col);
    if (key.endsWith('\u0000PRIMARY')) m.primaryKey = columns;
    else m.indexes.push({ name: rows[0].name, columns, unique: Number(rows[0].nonUnique) === 0, complex: columns.includes(null) });
  }
  for (const [, rows] of group(fks, (r) => r.t + '\u0000' + r.name)) {
    const m = models.get(rows[0].t);
    if (!m) continue;
    m.foreignKeys.push({
      name: rows[0].name,
      columns: rows.map((r) => r.col),
      refNs: rows[0].refNs,
      refTable: rows[0].refTable,
      refColumns: rows.map((r) => r.refCol),
      onUpdate: rows[0].upd,
      onDelete: rows[0].del,
    });
  }
  for (const v of views) {
    const m = models.get(v.name);
    if (m) m.definition = String(v.def || '').replaceAll('`' + ns + '`.', '');
  }
  return [...models.values()];
}

async function describePostgres(conn, ns, only) {
  const f = (col) => (only ? ` AND ${col} = ANY($2)` : '');
  const p = only ? [ns, only] : [ns];
  const [tables, cols, idx, fks] = await Promise.all([
    objects(
      conn,
      `SELECT c.relname AS name, c.relkind::text AS kind, obj_description(c.oid, 'pg_class') AS comment,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "rowsEst",
              CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END AS def
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')${f('c.relname')} ORDER BY 1`,
      p,
      ns,
    ),
    objects(
      conn,
      `SELECT c.relname AS t, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS dflt, a.attidentity::text AS ident, a.attgenerated::text AS gen,
              col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped${f('c.relname')}
       ORDER BY c.relname, a.attnum`,
      p,
    ),
    objects(
      conn,
      `SELECT t.relname AS t, i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS pk,
              (ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL) AS complex, pg_get_indexdef(ix.indexrelid) AS def,
              ARRAY(SELECT a.attname FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
              con.conname AS conname, con.contype::text AS contype
       FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid AND con.contype IN ('p','u')
       WHERE n.nspname = $1${f('t.relname')} ORDER BY 1, 2`,
      p,
    ),
    objects(
      conn,
      `SELECT cl.relname AS t, co.conname AS name,
              ARRAY(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY k(num, ord)
                    JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.num ORDER BY k.ord)::text[] AS cols,
              rn.nspname AS "refNs", rc.relname AS "refTable",
              ARRAY(SELECT a.attname FROM unnest(co.confkey) WITH ORDINALITY k(num, ord)
                    JOIN pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.num ORDER BY k.ord)::text[] AS "refCols",
              co.confupdtype::text AS upd, co.confdeltype::text AS del
       FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_class rc ON rc.oid = co.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       WHERE co.contype = 'f' AND n.nspname = $1${f('cl.relname')} ORDER BY 1, 2`,
      p,
    ),
  ]);

  const models = new Map();
  for (const t of tables) {
    const kind = t.kind === 'v' || t.kind === 'm' ? 'view' : 'table';
    models.set(
      t.name,
      newModel(t.name, kind, {
        comment: t.comment || '',
        rowsEstimate: t.rowsEst == null ? null : Number(t.rowsEst),
        definition: t.def ? String(t.def).trim().replace(/;$/, '') : undefined,
      }),
    );
  }
  for (const c of cols) {
    const m = models.get(c.t);
    if (!m) continue;
    const dflt = c.dflt == null ? null : String(c.dflt);
    const serial = dflt != null && /^nextval\(/i.test(dflt);
    const identity = c.ident === 'a' || c.ident === 'd';
    const gen = c.gen === 's' ? { expr: dflt, stored: true } : null;
    m.columns.push({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: serial || gen ? null : dflt,
      autoIncrement: serial || identity,
      identity: identity ? c.ident : serial ? 'serial' : null,
      onUpdateNow: false,
      comment: c.comment || '',
      generated: gen,
    });
  }
  for (const ix of idx) {
    const m = models.get(ix.t);
    if (!m) continue;
    if (ix.pk) {
      m.primaryKey = ix.cols;
      m.primaryKeyName = ix.conname || ix.name;
    } else {
      m.indexes.push({
        name: ix.name,
        columns: ix.cols,
        unique: ix.uniq,
        constraint: ix.contype === 'u' ? ix.conname : null,
        complex: ix.complex,
        def: ix.def,
      });
    }
  }
  for (const fk of fks) {
    const m = models.get(fk.t);
    if (!m) continue;
    m.foreignKeys.push({
      name: fk.name,
      columns: fk.cols,
      refNs: fk.refNs,
      refTable: fk.refTable,
      refColumns: fk.refCols,
      onUpdate: PG_RULE[fk.upd] || 'NO ACTION',
      onDelete: PG_RULE[fk.del] || 'NO ACTION',
    });
  }
  return [...models.values()];
}

async function describeSqlite(conn, ns, only) {
  const f = only ? ` AND m.name IN (${only.map(() => '?').join(',')})` : '';
  const p = only || [];
  const [tables, cols, idx, fks] = await Promise.all([
    objects(conn, `SELECT name, type AS kind, sql FROM sqlite_master m WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'${f} ORDER BY name`, p),
    objects(
      conn,
      `SELECT m.name AS t, pi.cid, pi.name, pi.type, pi."notnull" AS nn, pi.dflt_value AS dflt, pi.pk
       FROM sqlite_master m JOIN pragma_table_info(m.name) pi
       WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'${f} ORDER BY m.name, pi.cid`,
      p,
    ),
    objects(
      conn,
      `SELECT m.name AS t, il.name AS name, il."unique" AS uniq, il.origin AS origin, ii.name AS col
       FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii
       WHERE m.type = 'table'${f} ORDER BY m.name, il.name, ii.seqno`,
      p,
    ),
    objects(
      conn,
      `SELECT m.name AS t, fk.id, fk.seq, fk."table" AS refTable, fk."from" AS col, fk."to" AS refCol,
              fk.on_update AS upd, fk.on_delete AS del
       FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) fk
       WHERE m.type = 'table'${f} ORDER BY m.name, fk.id, fk.seq`,
      p,
    ),
  ]);

  const models = new Map();
  for (const t of tables) {
    const sql = String(t.sql || '');
    const m = newModel(t.name, t.kind === 'view' ? 'view' : 'table', { autoincrementKeyword: /\bAUTOINCREMENT\b/i.test(sql), sql });
    if (m.kind === 'view') {
      const mm = /^\s*CREATE\s+(?:TEMP\w*\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s*(?:\([^)]*\))?\s+AS\s+([\s\S]*)$/i.exec(sql);
      m.definition = mm ? mm[1].trim().replace(/;$/, '') : sql;
    }
    models.set(t.name, m);
  }
  const pkOrder = new Map();
  for (const c of cols) {
    const m = models.get(c.t);
    if (!m) continue;
    m.columns.push({
      name: c.name,
      type: c.type || '',
      nullable: !Number(c.nn),
      default: c.dflt == null ? null : String(c.dflt),
      autoIncrement: false,
      onUpdateNow: false,
      comment: '',
      generated: null,
    });
    if (Number(c.pk) > 0) {
      if (!pkOrder.has(c.t)) pkOrder.set(c.t, []);
      pkOrder.get(c.t).push([Number(c.pk), c.name]);
    }
  }
  for (const [t, list] of pkOrder) {
    const m = models.get(t);
    m.primaryKey = list.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    if (m.kind === 'table' && m.primaryKey.length === 1) {
      const col = m.columns.find((c) => c.name === m.primaryKey[0]);
      if (col && String(col.type).toUpperCase() === 'INTEGER') col.autoIncrement = true; // rowid alias
    }
  }
  for (const [, rows] of group(idx, (r) => r.t + '\u0000' + r.name)) {
    const m = models.get(rows[0].t);
    if (!m || rows[0].origin === 'pk') continue;
    const columns = rows.map((r) => r.col);
    m.indexes.push({
      name: rows[0].name,
      columns,
      unique: Boolean(Number(rows[0].uniq)),
      complex: columns.includes(null),
      auto: String(rows[0].name).startsWith('sqlite_autoindex'),
    });
  }
  for (const [, rows] of group(fks, (r) => r.t + '\u0000' + r.id)) {
    const m = models.get(rows[0].t);
    if (!m) continue;
    let refColumns = rows.map((r) => r.refCol);
    if (refColumns.includes(null)) {
      const ref = models.get(rows[0].refTable);
      refColumns = ref?.primaryKey?.length
        ? ref.primaryKey
        : (await objects(conn, 'SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', [rows[0].refTable])).map((r) => r.name);
    }
    m.foreignKeys.push({
      name: `fk_${rows[0].t}_${rows[0].refTable}_${rows[0].id}`,
      columns: rows.map((r) => r.col),
      refNs: 'main',
      refTable: rows[0].refTable,
      refColumns,
      onUpdate: String(rows[0].upd || 'NO ACTION').toUpperCase(),
      onDelete: String(rows[0].del || 'NO ACTION').toUpperCase(),
    });
  }
  return [...models.values()];
}

export async function describeSchema(conn, ns, only = null) {
  const list = only && only.length ? only : null;
  if (conn.type === 'mysql') return describeMysql(conn, ns, list);
  if (conn.type === 'postgres') return describePostgres(conn, ns, list);
  return describeSqlite(conn, ns, list);
}

export async function describeTable(conn, ns, table) {
  const [m] = await describeSchema(conn, ns, [table]);
  if (!m) throw new Error(t('Table not found: {name}', { name: table }));
  return m;
}

// ======================================================================
// Type mapping between dialects
// ======================================================================

export function canonicalType(type, from) {
  const t = String(type || '')
    .trim()
    .toLowerCase();
  if (/\[\]$/.test(t)) return { kind: 'text' };
  const args = (/\(([^)]*)\)/.exec(t)?.[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unsigned = /\bunsigned\b/.test(t);
  const base = t
    .replace(/\(.*?\)/g, '')
    .replace(/\b(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const num = (i) => (args[i] != null && /^\d+$/.test(args[i]) ? Number(args[i]) : null);

  if (from === 'mysql' && base === 'tinyint' && args[0] === '1') return { kind: 'bool' };
  if (base === 'bool' || base === 'boolean' || (base === 'bit' && (!args[0] || args[0] === '1'))) return { kind: 'bool' };
  if (['tinyint', 'smallint', 'int2', 'smallserial', 'year'].includes(base)) return { kind: 'int', size: unsigned ? 4 : 2 };
  if (['mediumint', 'int', 'integer', 'int4', 'serial'].includes(base)) {
    return { kind: 'int', size: unsigned || from === 'sqlite' ? 8 : 4 };
  }
  if (['bigint', 'int8', 'bigserial'].includes(base)) return unsigned ? { kind: 'decimal', p: 20, s: 0 } : { kind: 'int', size: 8 };
  if (base === 'money') return { kind: 'decimal', p: 19, s: 2 };
  if (['decimal', 'numeric', 'dec', 'fixed'].includes(base)) return { kind: 'decimal', p: num(0), s: num(1) ?? 0 };
  if (['float', 'real', 'float4'].includes(base)) return { kind: num(0) > 24 ? 'double' : 'float' };
  if (['double', 'double precision', 'float8'].includes(base)) return { kind: 'double' };
  if (['char', 'character', 'bpchar', 'nchar'].includes(base)) return { kind: 'char', len: num(0) ?? 1 };
  if (['varchar', 'character varying', 'nvarchar', 'varchar2', 'nvarchar2'].includes(base)) return { kind: 'varchar', len: num(0) };
  if (['tinytext', 'text', 'mediumtext', 'longtext', 'clob', 'citext', 'string', 'name', 'ntext'].includes(base)) {
    return { kind: 'text', size: base };
  }
  if (base === 'json' || base === 'jsonb') return { kind: 'json' };
  if (base === 'date') return { kind: 'date' };
  if (['time', 'time without time zone', 'timetz', 'time with time zone'].includes(base)) return { kind: 'time' };
  if (['datetime', 'timestamp', 'timestamp without time zone', 'smalldatetime', 'datetime2'].includes(base)) return { kind: 'datetime' };
  if (['timestamptz', 'timestamp with time zone', 'datetimeoffset'].includes(base)) return { kind: 'datetimetz' };
  if (['blob', 'tinyblob', 'mediumblob', 'longblob', 'bytea', 'binary', 'varbinary', 'image', 'bit', 'bit varying', 'varbit'].includes(base)) {
    return { kind: 'blob' };
  }
  if (base === 'uuid' || base === 'uniqueidentifier') return { kind: 'uuid' };
  if (base === 'enum' || base === 'set') return { kind: 'varchar', len: 255 };
  if (['inet', 'cidr', 'macaddr', 'macaddr8', 'interval'].includes(base)) return { kind: 'varchar', len: 64 };
  if (from === 'sqlite') {
    // SQLite affinity rules (https://sqlite.org/datatype3.html#determination_of_column_affinity)
    if (base === '') return { kind: 'text' };
    if (/int/.test(base)) return { kind: 'int', size: 8 };
    if (/char|clob|text/.test(base)) return { kind: 'text' };
    if (/blob/.test(base)) return { kind: 'blob' };
    if (/real|floa|doub/.test(base)) return { kind: 'double' };
    return { kind: 'decimal', p: null, s: 0 };
  }
  return { kind: 'text' };
}

function renderType(c, to) {
  const k = c.kind;
  if (to === 'mysql') {
    switch (k) {
      case 'bool':
        return 'tinyint(1)';
      case 'int':
        return c.size === 2 ? 'smallint' : c.size === 8 ? 'bigint' : 'int';
      case 'decimal':
        return c.p ? `decimal(${Math.min(c.p, 65)},${Math.min(c.s ?? 0, 30)})` : 'decimal(38,10)';
      case 'float':
        return 'float';
      case 'double':
        return 'double';
      case 'char':
        return c.len > 255 ? `varchar(${c.len})` : `char(${c.len || 1})`;
      case 'varchar':
        return c.len && c.len <= 16383 ? `varchar(${c.len})` : 'longtext';
      case 'text':
        return ['tinytext', 'text', 'mediumtext'].includes(c.size) ? c.size : 'longtext';
      case 'json':
        return 'json';
      case 'date':
        return 'date';
      case 'time':
        return 'time';
      case 'datetime':
      case 'datetimetz':
        return 'datetime';
      case 'blob':
        return 'longblob';
      case 'uuid':
        return 'char(36)';
      default:
        return 'longtext';
    }
  }
  if (to === 'postgres') {
    switch (k) {
      case 'bool':
        return 'boolean';
      case 'int':
        return c.size === 2 ? 'smallint' : c.size === 8 ? 'bigint' : 'integer';
      case 'decimal':
        return c.p ? `numeric(${c.p},${c.s ?? 0})` : 'numeric';
      case 'float':
        return 'real';
      case 'double':
        return 'double precision';
      case 'char':
        return `char(${c.len || 1})`;
      case 'varchar':
        return c.len ? `varchar(${c.len})` : 'text';
      case 'json':
        return 'jsonb';
      case 'date':
        return 'date';
      case 'time':
        return 'time';
      case 'datetime':
        return 'timestamp';
      case 'datetimetz':
        return 'timestamptz';
      case 'blob':
        return 'bytea';
      case 'uuid':
        return 'uuid';
      default:
        return 'text';
    }
  }
  switch (k) {
    case 'bool':
      return 'BOOLEAN';
    case 'int':
      return 'INTEGER';
    case 'decimal':
      return c.p ? `NUMERIC(${c.p},${c.s ?? 0})` : 'NUMERIC';
    case 'float':
    case 'double':
      return 'REAL';
    case 'char':
      return `CHAR(${c.len || 1})`;
    case 'varchar':
      return c.len ? `VARCHAR(${c.len})` : 'TEXT';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'datetime':
    case 'datetimetz':
      return 'DATETIME';
    case 'blob':
      return 'BLOB';
    default:
      return 'TEXT';
  }
}

export function mapType(type, from, to) {
  if (from === to) return type;
  return renderType(canonicalType(type, from), to);
}

function unwrap(d) {
  let s = d.trim();
  for (;;) {
    const before = s;
    s = s.replace(/::[a-z_][a-z0-9_ ]*(\[\])?(\(\d+(,\d+)?\))?$/i, '').trim(); // pg casts
    if (s.startsWith('(') && s.endsWith(')')) {
      let depth = 0;
      let wraps = true;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
        if (depth === 0 && i < s.length - 1) {
          wraps = false;
          break;
        }
      }
      if (wraps) s = s.slice(1, -1).trim();
    }
    if (s === before) return s;
  }
}

// Translate a default expression to another dialect; returns null when it cannot be expressed.
export function translateDefault(def, from, to, targetType) {
  if (def == null) return null;
  if (from === to) return String(def);
  const d = unwrap(String(def));
  const low = d.toLowerCase();
  const kind = canonicalType(targetType, to).kind;
  if (low === 'null') return null;
  if (/^(current_timestamp(\(\d*\))?|now\(\)|localtimestamp|getdate\(\)|datetime\('now'(,\s*'localtime')?\))$/.test(low)) {
    return kind === 'datetime' || kind === 'datetimetz' ? 'CURRENT_TIMESTAMP' : null;
  }
  if (/^(current_date|curdate\(\)|date\('now'(,\s*'localtime')?\))$/.test(low)) return to === 'mysql' ? '(CURRENT_DATE)' : 'CURRENT_DATE';
  const boolOut = (b) => (to === 'postgres' ? (b ? 'TRUE' : 'FALSE') : b ? '1' : '0');
  if (low === 'true' || low === 'false') return boolOut(low === 'true');
  const bit = /^b'([01])'$/.exec(low);
  if (bit) return boolOut(bit[1] === '1');
  if (/^-?\d+(\.\d+)?$/.test(d)) return kind === 'bool' ? boolOut(Number(d) !== 0) : d;
  if (/^'(?:[^']|'')*'$/s.test(d)) {
    if (to === 'mysql' && ['text', 'json', 'blob'].includes(kind)) return null; // MySQL < 8.0.13 rejects literal defaults here
    if (kind === 'bool') {
      const inner = d.slice(1, -1).toLowerCase();
      if (['1', 't', 'true', 'y', 'yes', 'on'].includes(inner)) return boolOut(true);
      if (['0', 'f', 'false', 'n', 'no', 'off'].includes(inner)) return boolOut(false);
    }
    return to === 'mysql' ? d.replaceAll('\\', '\\\\') : d;
  }
  return null;
}

// ======================================================================
// DDL generation
// ======================================================================

const INT_TYPES = /^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8)\b/i;

function lit(dialect, s) {
  const v = String(s);
  return "'" + (dialect === 'mysql' ? v.replaceAll('\\', '\\\\') : v).replaceAll("'", "''") + "'";
}

function ruleSQL(fk) {
  let s = '';
  const del = String(fk.onDelete || '').toUpperCase();
  const upd = String(fk.onUpdate || '').toUpperCase();
  if (RULES.has(del) && del !== 'NO ACTION') s += ` ON DELETE ${del}`;
  if (RULES.has(upd) && upd !== 'NO ACTION') s += ` ON UPDATE ${upd}`;
  return s;
}

function truncName(name) {
  return name.length > 63 ? name.slice(0, 55) + '_' + Math.abs(hash(name)).toString(36).slice(0, 7) : name;
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// Index / constraint names are global per schema in PostgreSQL & SQLite (and FK names per database in MySQL),
// so objects copied under a new table name need new names.
export function renameObject(objName, fromTable, toTable, suffix = '') {
  if (fromTable === toTable && !String(objName).startsWith('sqlite_autoindex')) return objName;
  if (String(objName).startsWith('sqlite_autoindex') || !objName) return truncName(`${toTable}_${suffix || 'idx'}`);
  return truncName(objName.includes(fromTable) ? objName.split(fromTable).join(toTable) : `${toTable}_${objName}`);
}

export function columnSQL(col, dialect, { from = dialect, rowidPk = false, autoincrementKeyword = false } = {}) {
  const t = dialect;
  const same = from === t;
  let type = same ? col.type : mapType(col.type, from, t);
  if (!type) type = t === 'sqlite' ? '' : 'text';
  const name = q(t, col.name);

  if (t === 'sqlite' && rowidPk) return `${name} INTEGER PRIMARY KEY${autoincrementKeyword ? ' AUTOINCREMENT' : ''}`;

  let out = `${name} ${type}`.trimEnd();
  const gen = same && col.generated?.expr ? col.generated : null;
  if (gen) {
    out += ` GENERATED ALWAYS AS (${gen.expr})${t === 'postgres' || gen.stored ? ' STORED' : t === 'mysql' ? ' VIRTUAL' : ''}`;
  }
  if (col.autoIncrement && t === 'postgres') {
    if (!INT_TYPES.test(type)) type = 'bigint';
    out = `${name} ${type} GENERATED BY DEFAULT AS IDENTITY`;
  }
  out += col.nullable === false || (col.autoIncrement && t !== 'sqlite') ? ' NOT NULL' : t === 'mysql' ? ' NULL' : '';
  if (!gen && !col.autoIncrement) {
    let def = same ? col.default : translateDefault(col.default, from, t, type);
    // SQLite only accepts function-call defaults inside parentheses: DEFAULT (date('now')).
    if (def != null && t === 'sqlite' && /^[A-Za-z_][\w]*\s*\(/.test(String(def).trim())) def = `(${def})`;
    if (def != null && def !== '') out += ` DEFAULT ${def}`;
  }
  if (t === 'mysql') {
    if (col.onUpdateNow && (same || /datetime|timestamp/i.test(type))) out += ' ON UPDATE CURRENT_TIMESTAMP';
    if (col.autoIncrement) out += ' AUTO_INCREMENT';
    if (col.comment) out += ` COMMENT ${lit('mysql', col.comment)}`;
  }
  return out;
}

function indexColumns(t, model, ix, typesByName) {
  return ix.columns
    .map((c) => {
      const ty = String(typesByName.get(c) || '');
      // MySQL can only index TEXT/BLOB with a prefix length
      return t === 'mysql' && /text|blob|json/i.test(ty) ? `${q(t, c)}(191)` : q(t, c);
    })
    .join(', ');
}

/**
 * Build DDL for a table model.
 * opts: { ns, from, name (target table name), fkMode: 'inline'|'alter'|'none', refNs, renameMap: {srcTable: dstTable},
 *         ifNotExists, includeIndexes }
 * Returns { create, indexes: [...], comments: [...], foreignKeys: [...ALTER statements] }
 */
export function createTableSQL(model, dialect, opts = {}) {
  const t = dialect;
  const from = opts.from || t;
  const same = from === t;
  const name = opts.name || model.name;
  const ns = opts.ns;
  const fkMode = opts.fkMode || 'inline';
  const renameMap = opts.renameMap || {};
  const target = qualified(t, ns, name);

  const pkCols = model.primaryKey || [];
  const rowidPk =
    t === 'sqlite' && pkCols.length === 1 && Boolean(model.columns.find((c) => c.name === pkCols[0])?.autoIncrement);
  const lines = model.columns.map((c) =>
    columnSQL(c, t, {
      from,
      rowidPk: rowidPk && c.name === pkCols[0],
      autoincrementKeyword: model.autoincrementKeyword || (from !== 'sqlite' && rowidPk),
    }),
  );
  if (pkCols.length && !rowidPk) lines.push(`PRIMARY KEY (${pkCols.map((c) => q(t, c)).join(', ')})`);

  const fkClause = (fk) => {
    const refTable = renameMap[fk.refTable] || fk.refTable;
    const refNs = t === 'sqlite' ? null : opts.refNs || (same && fk.refNs && fk.refNs !== opts.srcNs ? fk.refNs : ns);
    const fkName = renameObject(fk.name, model.name, name, `${fk.columns.join('_')}_fkey`);
    return `CONSTRAINT ${q(t, fkName)} FOREIGN KEY (${fk.columns.map((c) => q(t, c)).join(', ')}) REFERENCES ${qualified(
      t,
      refNs,
      refTable,
    )} (${fk.refColumns.map((c) => q(t, c)).join(', ')})${ruleSQL(fk)}`;
  };
  const fks = (model.foreignKeys || []).filter((fk) => !opts.fkFilter || opts.fkFilter(fk));
  if (fkMode === 'inline') for (const fk of fks) lines.push(fkClause(fk));

  let create = `CREATE TABLE ${opts.ifNotExists ? 'IF NOT EXISTS ' : ''}${target} (\n  ${lines.join(',\n  ')}\n)`;
  if (t === 'mysql') {
    const optsSql = [];
    if (same && model.engine) optsSql.push(`ENGINE=${model.engine}`);
    else optsSql.push('ENGINE=InnoDB');
    if (same && model.collation && /^\w+$/.test(model.collation)) {
      optsSql.push(`DEFAULT CHARSET=${model.collation.split('_')[0]} COLLATE=${model.collation}`);
    } else if (!same) optsSql.push('DEFAULT CHARSET=utf8mb4');
    if (model.comment) optsSql.push(`COMMENT=${lit('mysql', model.comment)}`);
    create += ' ' + optsSql.join(' ');
  }
  create += ';';

  const typesByName = new Map(model.columns.map((c) => [c.name, same ? c.type : mapType(c.type, from, t)]));
  const indexes = [];
  if (opts.includeIndexes !== false) {
    for (const ix of model.indexes || []) {
      if (ix.complex) {
        if (same && t === 'postgres' && ix.def && name === model.name && ns === opts.srcNs) indexes.push(ix.def + ';');
        continue;
      }
      const ixName = renameObject(ix.name, model.name, name, `${ix.columns.join('_')}_${ix.unique ? 'key' : 'idx'}`);
      indexes.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(t, ixName)} ON ${target} (${indexColumns(t, model, ix, typesByName)});`);
    }
  }

  const comments = [];
  if (t === 'postgres') {
    if (model.comment) comments.push(`COMMENT ON TABLE ${target} IS ${lit(t, model.comment)};`);
    for (const c of model.columns) if (c.comment) comments.push(`COMMENT ON COLUMN ${target}.${q(t, c.name)} IS ${lit(t, c.comment)};`);
  }

  const foreignKeys = fkMode === 'alter' && t !== 'sqlite' ? fks.map((fk) => `ALTER TABLE ${target} ADD ${fkClause(fk)};`) : [];
  return { create, indexes, comments, foreignKeys };
}

export function createTableStatements(model, dialect, opts = {}) {
  const r = createTableSQL(model, dialect, opts);
  return [r.create, ...r.indexes, ...r.comments, ...r.foreignKeys];
}

export function createViewSQL(model, dialect, { ns, name = model.name, from = dialect } = {}) {
  if (!model.definition) return null;
  let def = model.definition.trim().replace(/;$/, '');
  // MySQL writes view definitions with `backtick` identifiers; standard SQL uses "double quotes".
  if (from === 'mysql' && dialect !== 'mysql') {
    def = def.replace(/`((?:[^`]|``)*)`/g, (_m, s) => '"' + s.replaceAll('``', '`').replaceAll('"', '""') + '"');
  }
  return `CREATE VIEW ${qualified(dialect, ns, name)} AS\n${def};`;
}

// Human-readable DDL for the "DDL" tab.
export async function tableDDL(conn, ns, table) {
  if (conn.type === 'mysql') {
    const r = await raw(conn, `SHOW CREATE TABLE ${qualified('mysql', ns, table)}`);
    return String(r.rows[0]?.[1] ?? '') + ';';
  }
  if (conn.type === 'sqlite') {
    const r = await objects(conn, `SELECT sql FROM sqlite_master WHERE name = ? AND sql IS NOT NULL`, [table]);
    const idx = await objects(conn, `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, [table]);
    return [r[0]?.sql, ...idx.map((x) => x.sql)].filter(Boolean).map((s) => s + ';').join('\n\n');
  }
  const m = await describeTable(conn, ns, table);
  if (m.kind === 'view') return createViewSQL(m, 'postgres', { ns });
  return createTableStatements(m, 'postgres', { ns, srcNs: ns, fkMode: 'inline' }).join('\n\n');
}

// ======================================================================
// ALTER TABLE generation (table designer + schema sync)
// ======================================================================

const normType = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b(smallint|mediumint|int|integer|bigint)\(\d+\)/g, '$1')
    .trim();
const normDef = (d) =>
  d == null
    ? ''
    : String(d)
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/^current_timestamp\(\)$/, 'current_timestamp');
const normRule = (r) => {
  const s = String(r || '').toUpperCase();
  return s === 'NO ACTION' || s === 'RESTRICT' || s === '' ? '' : s;
};
const ixKey = (ix) => `${ix.unique ? 'U' : 'I'}:${ix.columns.join(',')}`;
const fkKey = (fk) => [fk.columns.join(','), fk.refTable, fk.refColumns.join(','), normRule(fk.onDelete), normRule(fk.onUpdate)].join('|');

function sameColumn(a, b) {
  return (
    a.name === b.name &&
    normType(a.type) === normType(b.type) &&
    Boolean(a.nullable) === Boolean(b.nullable) &&
    (a.autoIncrement ? '' : normDef(a.default)) === (b.autoIncrement ? '' : normDef(b.default)) &&
    Boolean(a.autoIncrement) === Boolean(b.autoIncrement) &&
    (a.comment || '') === (b.comment || '') &&
    Boolean(a.onUpdateNow) === Boolean(b.onUpdateNow)
  );
}

/**
 * Compute statements that turn `old` into `next`.
 * next.columns[i].origName links a column to its old name (undefined = new column).
 * next.name may differ from old.name (rename table).
 * Returns { statements, warnings }.
 */
export function alterTableSQL(old, next, ty, ns) {
  const warnings = [];
  // Primary-key columns are NOT NULL by definition (SQLite reports INTEGER PRIMARY KEY as nullable).
  const pkNotNull = (m) => ({ ...m, columns: m.columns.map((c) => ((m.primaryKey || []).includes(c.name) ? { ...c, nullable: false } : c)) });
  old = pkNotNull(old);
  next = pkNotNull(next);
  const oldCols = new Map(old.columns.map((c) => [c.name, c]));
  const nextCols = next.columns.map((c) => ({ ...c, origName: c.origName != null && oldCols.has(c.origName) ? c.origName : null }));
  const kept = nextCols.filter((c) => c.origName != null);
  const keptOrig = new Set(kept.map((c) => c.origName));
  const dropped = old.columns.filter((c) => !keptOrig.has(c.name));
  const added = nextCols.filter((c) => c.origName == null);
  const newName = next.name || old.name;
  const renamed = newName !== old.name;
  const T = qualified(ty, ns, old.name);
  const T2 = qualified(ty, ns, newName);

  // Map old names → new names for comparing keys that reference columns.
  const toNew = new Map(kept.map((c) => [c.origName, c.name]));
  const oldPkNew = old.primaryKey.map((c) => toNew.get(c) ?? `\u0000${c}`);
  const pkChanged = oldPkNew.join(',') !== (next.primaryKey || []).join(',');
  const remapIx = (ix) => ({ ...ix, columns: ix.columns.map((c) => toNew.get(c) ?? `\u0000${c}`) });
  const remapFk = (fk) => ({ ...fk, columns: fk.columns.map((c) => toNew.get(c) ?? `\u0000${c}`) });

  const oldIx = old.indexes.filter((i) => !i.complex).map((i) => ({ orig: i, key: ixKey(remapIx(i)) }));
  const newIx = (next.indexes || []).map((i) => ({ ix: i, key: ixKey(i) }));
  const ixDropped = oldIx.filter((o) => !newIx.some((n) => n.key === o.key)).map((o) => o.orig);
  const ixAdded = newIx.filter((n) => !oldIx.some((o) => o.key === n.key)).map((n) => n.ix);

  const oldFk = old.foreignKeys.map((f) => ({ orig: f, key: fkKey(remapFk(f)) }));
  const newFk = (next.foreignKeys || []).map((f) => ({ fk: f, key: fkKey(f) }));
  const fkDropped = oldFk.filter((o) => !newFk.some((n) => n.key === o.key)).map((o) => o.orig);
  const fkAdded = newFk.filter((n) => !oldFk.some((o) => o.key === n.key)).map((n) => n.fk);

  const commentChanged = (old.comment || '') !== (next.comment || '');
  const fkClause = (fk) =>
    `CONSTRAINT ${q(ty, fk.name || truncName(`${newName}_${fk.columns.join('_')}_fkey`))} FOREIGN KEY (${fk.columns
      .map((c) => q(ty, c))
      .join(', ')}) REFERENCES ${qualified(ty, ty === 'sqlite' ? null : ns, fk.refTable)} (${fk.refColumns.map((c) => q(ty, c)).join(', ')})${ruleSQL(fk)}`;
  const ixName = (ix) => ix.name || truncName(`${newName}_${ix.columns.join('_')}_${ix.unique ? 'key' : 'idx'}`);

  if (ty === 'mysql') {
    const statements = [];
    for (const fk of fkDropped) statements.push(`ALTER TABLE ${T} DROP FOREIGN KEY ${q(ty, fk.name)};`);
    const parts = [];
    for (const ix of ixDropped) parts.push(`DROP INDEX ${q(ty, ix.name)}`);
    if (pkChanged && old.primaryKey.length) parts.push('DROP PRIMARY KEY');
    for (const c of dropped) parts.push(`DROP COLUMN ${q(ty, c.name)}`);
    const oldOrder = old.columns.filter((c) => keptOrig.has(c.name)).map((c) => c.name);
    const newOrder = kept.map((c) => c.origName);
    nextCols.forEach((c, i) => {
      const pos = i === 0 ? ' FIRST' : ` AFTER ${q(ty, nextCols[i - 1].name)}`;
      if (c.origName == null) {
        parts.push(`ADD COLUMN ${columnSQL(c, ty)}${pos}`);
        return;
      }
      const o = oldCols.get(c.origName);
      const moved = oldOrder.indexOf(c.origName) !== newOrder.indexOf(c.origName);
      if (!sameColumn(o, c) || moved) parts.push(`CHANGE COLUMN ${q(ty, o.name)} ${columnSQL(c, ty)}${moved ? pos : ''}`);
    });
    if (pkChanged && next.primaryKey.length) parts.push(`ADD PRIMARY KEY (${next.primaryKey.map((c) => q(ty, c)).join(', ')})`);
    for (const ix of ixAdded) parts.push(`ADD ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ty, ixName(ix))} (${indexColumns(ty, next, ix, new Map(nextCols.map((c) => [c.name, c.type])))})`);
    if (commentChanged) parts.push(`COMMENT = ${lit(ty, next.comment || '')}`);
    if (parts.length) statements.push(`ALTER TABLE ${T}\n  ${parts.join(',\n  ')};`);
    if (renamed) statements.push(`RENAME TABLE ${T} TO ${T2};`);
    for (const fk of fkAdded) statements.push(`ALTER TABLE ${T2} ADD ${fkClause(fk)};`);
    return { statements, warnings };
  }

  if (ty === 'postgres') {
    const s = [];
    for (const fk of fkDropped) s.push(`ALTER TABLE ${T} DROP CONSTRAINT ${q(ty, fk.name)};`);
    for (const ix of ixDropped) {
      s.push(ix.constraint ? `ALTER TABLE ${T} DROP CONSTRAINT ${q(ty, ix.constraint)};` : `DROP INDEX ${qualified(ty, ns, ix.name)};`);
    }
    if (pkChanged && old.primaryKey.length) s.push(`ALTER TABLE ${T} DROP CONSTRAINT ${q(ty, old.primaryKeyName || `${old.name}_pkey`)};`);
    for (const c of kept) if (c.name !== c.origName) s.push(`ALTER TABLE ${T} RENAME COLUMN ${q(ty, c.origName)} TO ${q(ty, c.name)};`);
    for (const c of dropped) s.push(`ALTER TABLE ${T} DROP COLUMN ${q(ty, c.name)};`);
    for (const c of added) s.push(`ALTER TABLE ${T} ADD COLUMN ${columnSQL(c, ty)};`);
    for (const c of kept) {
      const o = oldCols.get(c.origName);
      const col = `ALTER TABLE ${T} ALTER COLUMN ${q(ty, c.name)}`;
      if (normType(o.type) !== normType(c.type)) s.push(`${col} TYPE ${c.type} USING ${q(ty, c.name)}::${c.type};`);
      if (Boolean(o.autoIncrement) !== Boolean(c.autoIncrement)) {
        if (c.autoIncrement) {
          if (o.default != null) s.push(`${col} DROP DEFAULT;`);
          s.push(`${col} ADD GENERATED BY DEFAULT AS IDENTITY;`);
        } else if (o.identity === 'serial') s.push(`${col} DROP DEFAULT;`);
        else s.push(`${col} DROP IDENTITY IF EXISTS;`);
      }
      if (Boolean(o.nullable) !== Boolean(c.nullable)) s.push(`${col} ${c.nullable ? 'DROP' : 'SET'} NOT NULL;`);
      if (!c.autoIncrement && normDef(o.default) !== normDef(c.default)) {
        s.push(c.default == null || c.default === '' ? `${col} DROP DEFAULT;` : `${col} SET DEFAULT ${c.default};`);
      }
      if ((o.comment || '') !== (c.comment || '')) {
        s.push(`COMMENT ON COLUMN ${T}.${q(ty, c.name)} IS ${c.comment ? lit(ty, c.comment) : 'NULL'};`);
      }
    }
    for (const c of added) if (c.comment) s.push(`COMMENT ON COLUMN ${T}.${q(ty, c.name)} IS ${lit(ty, c.comment)};`);
    if (pkChanged && next.primaryKey.length) s.push(`ALTER TABLE ${T} ADD PRIMARY KEY (${next.primaryKey.map((c) => q(ty, c)).join(', ')});`);
    for (const ix of ixAdded) s.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ty, ixName(ix))} ON ${T} (${ix.columns.map((c) => q(ty, c)).join(', ')});`);
    for (const fk of fkAdded) s.push(`ALTER TABLE ${T} ADD ${fkClause(fk)};`);
    if (commentChanged) s.push(`COMMENT ON TABLE ${T} IS ${next.comment ? lit(ty, next.comment) : 'NULL'};`);
    if (renamed) s.push(`ALTER TABLE ${T} RENAME TO ${q(ty, newName)};`);
    const oldOrder = old.columns.filter((c) => keptOrig.has(c.name)).map((c) => c.name).join(',');
    if (oldOrder !== kept.map((c) => c.origName).join(',')) warnings.push(t('PostgreSQL cannot reorder columns; the new order is ignored.'));
    return { statements: s, warnings };
  }

  // ---- SQLite: cheap ALTERs when possible, otherwise rebuild the table ----
  const typeChanged = kept.some((c) => !sameColumn({ ...oldCols.get(c.origName), name: c.name }, c));
  const orderChanged =
    old.columns.filter((c) => keptOrig.has(c.name)).map((c) => c.name).join(',') !== kept.map((c) => c.origName).join(',') ||
    nextCols.findIndex((c) => c.origName == null) !== -1 && nextCols.slice(nextCols.findIndex((c) => c.origName == null)).some((c) => c.origName != null);
  const addedOk = added.every((c) => !(next.primaryKey || []).includes(c.name) && (c.nullable !== false || c.default != null) && !c.autoIncrement);
  const simple = !dropped.length && !typeChanged && !orderChanged && !pkChanged && !fkDropped.length && !fkAdded.length && addedOk;

  if (simple) {
    const s = [];
    for (const ix of ixDropped) s.push(`DROP INDEX ${q(ty, ix.name)};`);
    for (const c of kept) if (c.name !== c.origName) s.push(`ALTER TABLE ${T} RENAME COLUMN ${q(ty, c.origName)} TO ${q(ty, c.name)};`);
    for (const c of added) s.push(`ALTER TABLE ${T} ADD COLUMN ${columnSQL(c, ty)};`);
    if (renamed) s.push(`ALTER TABLE ${T} RENAME TO ${q(ty, newName)};`);
    for (const ix of ixAdded) s.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ty, ixName(ix))} ON ${T2} (${ix.columns.map((c) => q(ty, c)).join(', ')});`);
    return { statements: s, warnings };
  }

  const tmp = `_dbstudio_new_${newName}`;
  const model = { ...next, name: tmp, columns: nextCols, indexes: [], foreignKeys: next.foreignKeys || [] };
  const { create } = createTableSQL(model, 'sqlite', { fkMode: 'inline', includeIndexes: false });
  const s = ['PRAGMA foreign_keys = OFF;', 'BEGIN;', create];
  if (kept.length) {
    s.push(`INSERT INTO ${q(ty, tmp)} (${kept.map((c) => q(ty, c.name)).join(', ')}) SELECT ${kept.map((c) => q(ty, c.origName)).join(', ')} FROM ${T};`);
  }
  s.push(`DROP TABLE ${T};`, `ALTER TABLE ${q(ty, tmp)} RENAME TO ${q(ty, newName)};`);
  for (const ix of next.indexes || []) {
    s.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ty, ix.name && !ix.name.startsWith('sqlite_') ? ix.name : ixName({ ...ix, name: null }))} ON ${T2} (${ix.columns.map((c) => q(ty, c)).join(', ')});`);
  }
  s.push('COMMIT;', 'PRAGMA foreign_keys = ON;');
  warnings.push(t('SQLite will rebuild the table for this change (data is copied into a new table). Triggers on this table are dropped too.'));
  return { statements: s, warnings };
}

// ======================================================================
// Schema compare / sync (same engine on both sides)
// ======================================================================

export async function compareSchemas(srcConn, srcNs, dstConn, dstNs, { includeDrops = false } = {}) {
  if (srcConn.type !== dstConn.type) throw new Error(t('Schema compare needs the same database engine on both sides.'));
  const ty = srcConn.type;
  const [a, b] = await Promise.all([describeSchema(srcConn, srcNs), describeSchema(dstConn, dstNs)]);
  const bTables = new Map(b.filter((x) => x.kind === 'table').map((x) => [x.name, x]));
  const items = [];
  const deferredFks = [];
  for (const src of a.filter((x) => x.kind === 'table')) {
    const dst = bTables.get(src.name);
    if (!dst) {
      const r = createTableSQL(src, ty, { ns: dstNs, srcNs, fkMode: ty === 'sqlite' ? 'inline' : 'alter' });
      items.push({ table: src.name, status: 'missing', statements: [r.create, ...r.indexes, ...r.comments] });
      deferredFks.push(...r.foreignKeys);
      continue;
    }
    const next = {
      ...src,
      columns: src.columns.map((c) => ({ ...c, origName: dst.columns.some((o) => o.name === c.name) ? c.name : undefined })),
    };
    const { statements, warnings } = alterTableSQL(dst, next, ty, dstNs);
    items.push({ table: src.name, status: statements.length ? 'different' : 'same', statements, warnings });
  }
  for (const dst of b.filter((x) => x.kind === 'table')) {
    if (!a.some((x) => x.kind === 'table' && x.name === dst.name)) {
      items.push({
        table: dst.name,
        status: 'extra',
        statements: includeDrops ? [`DROP TABLE ${qualified(ty, dstNs, dst.name)};`] : [],
      });
    }
  }
  if (deferredFks.length) items.push({ table: '(foreign keys)', status: 'missing', statements: deferredFks });
  return items;
}

// ======================================================================
// Namespace / table / user SQL helpers
// ======================================================================

const IDENT_OK = /^[A-Za-z0-9_]+$/;

export function namespaceSQL(type, action, { name, charset, collation, kind } = {}) {
  if (!name || !String(name).trim()) throw new Error(t('Name is required'));
  if (type === 'sqlite') throw new Error(t('SQLite: one file = one database. Create a new SQLite connection with a new file path.'));
  if (charset && !IDENT_OK.test(charset)) throw new Error(t('Invalid charset'));
  if (collation && !IDENT_OK.test(collation)) throw new Error(t('Invalid collation'));
  if (type === 'mysql') {
    if (action === 'create') {
      return [`CREATE DATABASE ${q(type, name)}${charset ? ` CHARACTER SET ${charset}` : ''}${collation ? ` COLLATE ${collation}` : ''};`];
    }
    return [`DROP DATABASE ${q(type, name)};`];
  }
  const what = kind === 'database' ? 'DATABASE' : 'SCHEMA';
  if (action === 'create') return [`CREATE ${what} ${q(type, name)};`];
  return [`DROP ${what} ${q(type, name)}${what === 'SCHEMA' ? ' CASCADE' : ''};`];
}

export function tableOpSQL(type, ns, op, table, { newName, kind = 'table' } = {}) {
  const T = qualified(type, ns, table);
  switch (op) {
    case 'drop':
      return [`DROP ${kind === 'view' ? 'VIEW' : 'TABLE'} ${T};`];
    case 'truncate':
      return type === 'sqlite' ? [`DELETE FROM ${T};`] : [`TRUNCATE TABLE ${T};`];
    case 'empty':
      return [`DELETE FROM ${T};`];
    case 'rename':
      if (!newName) throw new Error(t('New name is required'));
      return type === 'mysql' ? [`RENAME TABLE ${T} TO ${qualified(type, ns, newName)};`] : [`ALTER TABLE ${T} RENAME TO ${q(type, newName)};`];
    default:
      throw new Error(t('Unknown table operation'));
  }
}

const MYSQL_PRIVS = new Set([
  'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW',
  'SHOW VIEW', 'TRIGGER', 'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'LOCK TABLES', 'CREATE TEMPORARY TABLES',
]);
const PG_PRIVS = new Set(['ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']);

export function userSQL(type, action, { user, host = '%', password, privileges = [], ns } = {}) {
  if (!user) throw new Error(t('User name is required'));
  if (type === 'sqlite') throw new Error(t('SQLite has no users'));
  const privs = privileges.map((p) => String(p).toUpperCase());
  const allowed = type === 'mysql' ? MYSQL_PRIVS : PG_PRIVS;
  for (const p of privs) if (!allowed.has(p)) throw new Error(t('Unknown privilege: {name}', { name: p }));
  if (type === 'mysql') {
    const who = `${lit('mysql', user)}@${lit('mysql', host || '%')}`;
    const on = ns && ns !== '*' ? `${q('mysql', ns)}.*` : '*.*';
    if (action === 'create') return [`CREATE USER ${who} IDENTIFIED BY ${lit('mysql', password || '')};`];
    if (action === 'password') return [`ALTER USER ${who} IDENTIFIED BY ${lit('mysql', password || '')};`];
    if (action === 'drop') return [`DROP USER ${who};`];
    if (!privs.length) throw new Error(t('Select at least one privilege'));
    if (action === 'grant') return [`GRANT ${privs.join(', ')} ON ${on} TO ${who};`];
    if (action === 'revoke') return [`REVOKE ${privs.join(', ')} ON ${on} FROM ${who};`];
  } else {
    const role = q('postgres', user);
    if (action === 'create') return [`CREATE ROLE ${role} LOGIN PASSWORD ${lit('postgres', password || '')};`];
    if (action === 'password') return [`ALTER ROLE ${role} PASSWORD ${lit('postgres', password || '')};`];
    if (action === 'drop') return [`DROP ROLE ${role};`];
    if (!privs.length) throw new Error(t('Select at least one privilege'));
    if (!ns) throw new Error(t('Select a schema'));
    const S = q('postgres', ns);
    if (action === 'grant') return [`GRANT USAGE ON SCHEMA ${S} TO ${role};`, `GRANT ${privs.join(', ')} ON ALL TABLES IN SCHEMA ${S} TO ${role};`];
    if (action === 'revoke') return [`REVOKE ${privs.join(', ')} ON ALL TABLES IN SCHEMA ${S} FROM ${role};`];
  }
  throw new Error(t('Unknown user action'));
}
