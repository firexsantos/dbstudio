// SQL dump export, full-table CSV/JSON export, and SQL script import.
import { createWriteStream, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as db from './drivers.js';
import { describeSchema, createTableSQL, createViewSQL, canonicalType, mapType } from './schema.js';
import { readRows, insertableColumns } from './copy.js';
import { buildXlsx } from './xlsx.js';
import { t, plural, num } from './i18n.js';

const { q, qualified } = db;

function strLit(s, to) {
  let v = String(s);
  if (to === 'mysql') {
    v = v
      .replaceAll('\\', '\\\\')
      .replaceAll('\0', '\\0')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('\x1a', '\\Z');
  }
  return "'" + v.replaceAll("'", "''") + "'";
}

const NUMERIC = new Set(['int', 'decimal', 'float', 'double']);

export function literal(v, to, kind) {
  if (v == null) return 'NULL';
  if (kind === 'bool') {
    const b = typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : ['1', 't', 'true', 'y', 'yes', 'on'].includes(String(v).toLowerCase());
    return to === 'postgres' ? (b ? 'TRUE' : 'FALSE') : b ? '1' : '0';
  }
  if (typeof v === 'boolean') return to === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return Number.isFinite(Number(v)) ? String(v) : 'NULL';
  if (v instanceof Uint8Array) {
    const buf = Buffer.from(v);
    if (kind !== 'blob') return strLit(buf.toString('utf8'), to);
    return to === 'postgres' ? `'\\x${buf.toString('hex')}'` : `X'${buf.toString('hex')}'`;
  }
  if (Array.isArray(v) && to === 'postgres' && kind !== 'json') {
    return strLit('{' + v.map((x) => (x == null ? 'NULL' : '"' + String(x).replace(/["\\]/g, '\\$&') + '"')).join(',') + '}', to);
  }
  if (typeof v === 'object') return strLit(JSON.stringify(v), to);
  const s = String(v);
  if (NUMERIC.has(kind) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return s;
  if (to === 'mysql' && (kind === 'datetime' || kind === 'datetimetz')) return strLit(s.replace('T', ' ').replace(/([+-]\d\d(:?\d\d)?|Z)$/, ''), to);
  return strLit(s, to);
}

async function write(out, str) {
  if (!out.write(str)) await once(out, 'drain');
}

const TYPE_NAME = { mysql: 'MySQL/MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };

/**
 * opts: { conn, ns, tables: [names] | null (all), views: bool, structure, data, dropTable, dialect (target) }
 */
export async function runDump(ctx, opts) {
  const { conn, ns, structure = true, data = true, dropTable = true } = opts;
  const from = conn.type;
  const to = opts.dialect || from;
  ctx.progress(0.01, t('Reading structure'));
  const all = await describeSchema(conn, ns, opts.tables && opts.tables.length ? opts.tables : null);
  const tables = all.filter((m) => m.kind === 'table');
  const views = opts.views === false ? [] : all.filter((m) => m.kind === 'view');
  const counts = new Map();
  if (data) for (const m of tables) counts.set(m.name, Number((await db.raw(conn, `SELECT COUNT(*) FROM ${qualified(from, ns, m.name)}`)).rows[0][0]));
  const totalRows = [...counts.values()].reduce((a, b) => a + b, 0);
  let doneRows = 0;

  const fileName = `${ns || 'database'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sql`;
  const file = join(tmpdir(), `dbstudio-${ctx.job.id}.sql`);
  const out = createWriteStream(file);
  ctx.setFile(file, fileName);
  const info = await db.serverInfo(conn);
  try {
    await write(
      out,
      `-- DBStudio SQL dump\n-- ${t('Source')} : ${TYPE_NAME[from]} ${info.version}\n-- ${from === 'postgres' ? 'Schema' : 'Database'}: ${ns}\n` +
        `-- ${t('Dialect')} : ${TYPE_NAME[to]}\n-- ${t('Created')} : ${new Date().toISOString()}\n\n`,
    );
    if (to === 'mysql') await write(out, 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n');
    if (to === 'postgres') await write(out, "SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\n");
    if (to === 'sqlite') await write(out, 'PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n');

    const after = [];
    const fkAfter = [];
    for (const m of tables) {
      ctx.checkCancel();
      ctx.item(m.name, { table: m.name, rows: counts.get(m.name) || 0, done: 0, state: 'writing', status: t('writing') });
      await write(out, `-- ----------------------------------------\n-- ${t('Table {name}', { name: m.name })}\n-- ----------------------------------------\n`);
      if (structure) {
        if (dropTable) await write(out, `DROP TABLE IF EXISTS ${q(to, m.name)}${to === 'postgres' ? ' CASCADE' : ''};\n`);
        const ddl = createTableSQL(m, to, { from, fkMode: to === 'sqlite' ? 'inline' : 'alter', srcNs: ns });
        await write(out, ddl.create + '\n\n');
        after.push(...ddl.indexes, ...ddl.comments);
        fkAfter.push(...ddl.foreignKeys);
      }
      if (data && counts.get(m.name)) {
        const cols = insertableColumns(m, from, to);
        const kinds = cols.map((c) => canonicalType(from === to ? m.columns.find((x) => x.name === c).type : mapType(m.columns.find((x) => x.name === c).type, from, to), to).kind);
        const head = `INSERT INTO ${q(to, m.name)} (${cols.map((c) => q(to, c)).join(', ')}) VALUES\n`;
        let done = 0;
        for await (const chunk of readRows(conn, ns, m, cols, 1000)) {
          ctx.checkCancel();
          for (let i = 0; i < chunk.length; i += 100) {
            const part = chunk.slice(i, i + 100);
            await write(out, head + part.map((r) => '  (' + r.map((v, j) => literal(v, to, kinds[j])).join(', ') + ')').join(',\n') + ';\n');
          }
          done += chunk.length;
          doneRows += chunk.length;
          ctx.item(m.name, { done });
          ctx.progress(0.05 + 0.9 * (totalRows ? doneRows / totalRows : 1), t('Writing {name}', { name: m.name }));
        }
        await write(out, '\n');
        if (to === 'postgres') {
          for (const c of m.columns.filter((x) => x.autoIncrement)) {
            after.push(
              `SELECT setval(pg_get_serial_sequence('${q(to, m.name).replaceAll("'", "''")}', '${c.name.replaceAll("'", "''")}'), COALESCE(MAX(${q(to, c.name)}), 1), MAX(${q(to, c.name)}) IS NOT NULL) FROM ${q(to, m.name)};`,
            );
          }
        }
      }
      ctx.item(m.name, { state: 'done', status: t('done') });
    }
    if (after.length) await write(out, `-- ${t('Indexes, comments & sequences')}\n` + after.join('\n') + '\n\n');
    if (fkAfter.length) await write(out, `-- ${t('Relations (foreign keys)')}\n` + fkAfter.join('\n') + '\n\n');
    if (structure && views.length) {
      await write(out, `-- ${t('Views')}\n`);
      for (const v of views) {
        if (dropTable) await write(out, `DROP VIEW IF EXISTS ${q(to, v.name)};\n`);
        const sql = createViewSQL(v, to, { from });
        if (sql) await write(out, sql + '\n\n');
      }
    }
    if (to === 'mysql') await write(out, 'SET FOREIGN_KEY_CHECKS = 1;\n');
    if (to === 'sqlite') await write(out, 'COMMIT;\nPRAGMA foreign_keys = ON;\n');
  } finally {
    out.end();
    await once(out, 'close');
  }
  ctx.log(t('{tables}, {views}, {rows}', { tables: plural(tables.length, '{n} table', '{n} tables'), views: plural(views.length, '{n} view', '{n} views'), rows: plural(doneRows, '{n} row', '{n} rows') }));
  return { tables: tables.length, views: views.length, rows: doneRows, fileName };
}

/** Full-table export to CSV or JSON. opts: { conn, ns, table, format: 'csv'|'json', delimiter } */
export async function runTableExport(ctx, opts) {
  const { conn, ns, table, format = 'csv' } = opts;
  const delim = opts.delimiter === ';' ? ';' : opts.delimiter === '\t' ? '\t' : ',';
  const [m] = await describeSchema(conn, ns, [table]);
  if (!m) throw new Error(t('Table not found: {name}', { name: table }));
  const cols = m.columns.map((c) => c.name);
  const total = Number((await db.raw(conn, `SELECT COUNT(*) FROM ${qualified(conn.type, ns, table)}`)).rows[0][0]);
  const file = join(tmpdir(), `dbstudio-${ctx.job.id}.${format}`);
  ctx.setFile(file, `${table}.${format}`);
  if (format === 'xlsx') {
    if (total > 1_048_575) throw new Error(t('Excel holds at most {max} rows — use CSV.', { max: num(1_048_575) }));
    const all = [];
    for await (const chunk of readRows(conn, ns, m, cols, 5000)) {
      ctx.checkCancel();
      all.push(...chunk);
      ctx.progress(total ? (0.9 * all.length) / total : 0.9, t('{done} / {total} rows', { done: num(all.length), total: num(total) }));
    }
    ctx.progress(0.95, t('Building the Excel file'));
    writeFileSync(file, buildXlsx(cols, all, table));
    return { rows: all.length, fileName: `${table}.xlsx` };
  }
  const out = createWriteStream(file);
  const cell = (v) => {
    if (v == null) return '';
    const s = v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.includes(delim) || /["\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  let done = 0;
  try {
    await write(out, format === 'csv' ? '\ufeff' + cols.map(cell).join(delim) + '\r\n' : '[\n');
    let first = true;
    for await (const chunk of readRows(conn, ns, m, cols, 2000)) {
      ctx.checkCancel();
      if (format === 'csv') await write(out, chunk.map((r) => r.map(cell).join(delim)).join('\r\n') + '\r\n');
      else {
        const parts = chunk.map((r) =>
          JSON.stringify(Object.fromEntries(cols.map((c, i) => [c, r[i] instanceof Uint8Array ? Buffer.from(r[i]).toString('base64') : r[i]]))),
        );
        await write(out, (first ? '  ' : ',\n  ') + parts.join(',\n  '));
        first = false;
      }
      done += chunk.length;
      ctx.progress(total ? done / total : 1, t('{done} / {total} rows', { done: num(done), total: num(total) }));
    }
    if (format === 'json') await write(out, '\n]\n');
  } finally {
    out.end();
    await once(out, 'close');
  }
  return { rows: done, fileName: `${table}.${format}` };
}

/** Execute an uploaded SQL script statement by statement. opts: { conn, ns, sql, continueOnError } */
export async function runImport(ctx, opts) {
  const { conn, ns, sql, continueOnError = false } = opts;
  if (/^\s*COPY\s+[\s\S]+?\s+FROM\s+stdin/im.test(sql)) {
    throw new Error(t('This file uses "COPY ... FROM stdin" (pg_dump format). Recreate the dump with: pg_dump --inserts'));
  }
  ctx.progress(0.01, t('Splitting statements'));
  const statements = db.splitStatements(sql, conn.type);
  ctx.log(plural(statements.length, '{n} statement found', '{n} statements found'));
  const errors = [];
  let ok = 0;
  await db.withSession(conn, ns, async (s) => {
    for (let i = 0; i < statements.length; i++) {
      if (i % 25 === 0) ctx.checkCancel();
      try {
        await s.run(statements[i]);
        ok++;
      } catch (e) {
        errors.push({ index: i + 1, sql: statements[i].slice(0, 300), error: e.message });
        ctx.log(`#${i + 1}: ${e.message}`, 'error');
        if (!continueOnError) {
          if (conn.type === 'sqlite') {
            await s.run('ROLLBACK').catch(() => {});
            await s.run('PRAGMA foreign_keys = ON').catch(() => {});
          }
          if (conn.type === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
          throw new Error(t('Stopped at statement #{index}: {error}', { index: i + 1, error: e.message }));
        }
        if (errors.length >= 500) throw new Error(t('Too many errors ({max}), import stopped', { max: 500 }));
      }
      ctx.progress((i + 1) / statements.length, t('Statement {done} / {total}', { done: num(i + 1), total: num(statements.length) }));
    }
  });
  return { statements: statements.length, ok, errors };
}
