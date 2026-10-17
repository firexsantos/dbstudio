// Data synchronization (Navicat-style): compare table contents by primary key between a source and a
// target (any engine), then apply INSERT / UPDATE / DELETE to the target or export them as an SQL script.
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import * as db from './drivers.js';
import { describeSchema, canonicalType, mapType } from './schema.js';
import { readRows, convertValue } from './copy.js';
import { literal } from './transfer.js';
import { t, num } from './i18n.js';

const { q, qualified, placeholder } = db;
const MAX_ROWS = 500_000;
const SAMPLE = 60;
const state = new Map(); // compare job id -> { src, dst, srcNs, dstNs, tables: [...] }

// Canonical form so equal values compare equal across drivers/engines.
function canon(v, kind, coarse = false) {
  if (v == null) return null;
  if (v instanceof Uint8Array) return 'x' + Buffer.from(v).toString('hex');
  if (kind === 'bool') return ['1', 't', 'true', 'y', 'yes', 'on'].includes(String(v).toLowerCase()) || v === true ? '1' : '0';
  if (kind === 'int' || kind === 'decimal' || kind === 'float' || kind === 'double') {
    const n = Number(v);
    if (Number.isFinite(n) && Math.abs(n) < 2 ** 53) return String(n);
    return String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  if (kind === 'json') {
    try {
      const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
      return JSON.stringify(sort(typeof v === 'string' ? JSON.parse(v) : v));
    } catch {
      return String(v);
    }
  }
  if (kind === 'datetime' || kind === 'datetimetz' || kind === 'date' || kind === 'time') {
    const s = String(v).replace('T', ' ').replace(/(Z|[+-]00(:?00)?)$/, '');
    // Engines differ in fractional-second precision (PostgreSQL µs vs MySQL DATETIME seconds).
    return coarse ? s.replace(/\.\d+$/, '') : s.replace(/\.0+$/, '');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Parents before children (for inserts/updates); reversed for deletes.
function dependencyOrder(models) {
  const names = new Set(models.map((m) => m.name));
  const done = new Set();
  const out = [];
  const visit = (m, stack = new Set()) => {
    if (done.has(m.name) || stack.has(m.name)) return;
    stack.add(m.name);
    for (const fk of m.foreignKeys || []) {
      const parent = models.find((x) => x.name === fk.refTable);
      if (parent && names.has(parent.name) && parent !== m) visit(parent, stack);
    }
    done.add(m.name);
    out.push(m);
  };
  models.forEach((m) => visit(m));
  return out;
}

/**
 * opts: { src, srcNs, dst, dstNs, tables: [{ name, target }] }
 * Result: per-table summary + samples. Full diff stays on the server for apply/script.
 */
export async function runCompare(ctx, opts) {
  const { src, srcNs, dst, dstNs } = opts;
  const pairs = opts.tables || [];
  if (!pairs.length) throw new Error(t('Select at least one table'));
  ctx.progress(0.02, t('Reading structure'));
  const [srcModels, dstModels] = await Promise.all([
    describeSchema(src, srcNs, pairs.map((p) => p.name)),
    describeSchema(dst, dstNs, pairs.map((p) => p.target || p.name)),
  ]);
  const tables = [];
  const summary = [];
  for (let i = 0; i < pairs.length; i++) {
    ctx.checkCancel();
    const p = pairs[i];
    const target = p.target || p.name;
    const sm = srcModels.find((m) => m.name === p.name);
    const dm = dstModels.find((m) => m.name === target);
    const base = { table: p.name, target };
    ctx.item(p.name, { ...base, state: 'comparing', status: t('comparing') });
    if (!sm || !dm) {
      summary.push({ ...base, error: !sm ? t('Source table does not exist') : t('Target table does not exist') });
      ctx.item(p.name, { state: 'skipped', status: t('skipped') });
      continue;
    }
    const key = sm.primaryKey.length ? sm.primaryKey : dm.primaryKey;
    const dstCols = new Map(dm.columns.map((c) => [c.name, c]));
    if (!key.length || !key.every((k) => dstCols.has(k) && sm.columns.some((c) => c.name === k))) {
      summary.push({ ...base, error: t('Both tables need the same primary key') });
      ctx.item(p.name, { state: 'skipped', status: t('skipped') });
      continue;
    }
    const cols = sm.columns.filter((c) => dstCols.has(c.name) && !c.generated && !dstCols.get(c.name).generated).map((c) => c.name);
    const ignored = sm.columns.filter((c) => !dstCols.has(c.name)).map((c) => c.name);
    const kinds = cols.map((c) => canonicalType(sm.columns.find((x) => x.name === c).type, src.type).kind);
    const keyIdx = key.map((k) => cols.indexOf(k));
    const coarse = src.type !== dst.type;
    const keyOf = (row) => JSON.stringify(keyIdx.map((i) => canon(row[i], kinds[i], coarse)));

    const srcMap = new Map();
    let n = 0;
    for await (const chunk of readRows(src, srcNs, sm, cols, 2000)) {
      ctx.checkCancel();
      for (const r of chunk) srcMap.set(keyOf(r), r);
      n += chunk.length;
      if (n > MAX_ROWS) throw new Error(t('{table}: more than {max} rows — use a filter or copy the table.', { table: p.name, max: num(MAX_ROWS) }));
      ctx.progress((i + 0.4) / pairs.length, t('Reading {table} (source) — {n}', { table: p.name, n: num(n) }));
    }
    const inserts = new Map(srcMap);
    const updates = [];
    const deletes = [];
    let same = 0;
    let dn = 0;
    for await (const chunk of readRows(dst, dstNs, dm, cols, 2000)) {
      ctx.checkCancel();
      for (const r of chunk) {
        const k = keyOf(r);
        const s = srcMap.get(k);
        if (!s) {
          deletes.push(r);
          continue;
        }
        inserts.delete(k);
        const changed = [];
        for (let c = 0; c < cols.length; c++) if (canon(s[c], kinds[c], coarse) !== canon(r[c], kinds[c], coarse)) changed.push(c);
        if (changed.length) updates.push({ src: s, dst: r, changed });
        else same++;
      }
      dn += chunk.length;
      if (dn > MAX_ROWS) throw new Error(t('{table}: more than {max} rows.', { table: target, max: num(MAX_ROWS) }));
      ctx.progress((i + 0.8) / pairs.length, t('Reading {table} (target) — {n}', { table: target, n: num(dn) }));
    }
    const tb = { table: p.name, target, sm, dm, cols, key, kinds, inserts: [...inserts.values()], updates, deletes };
    tables.push(tb);
    const res = {
      ...base,
      key,
      columns: cols,
      ignored,
      srcRows: n,
      dstRows: dn,
      insert: tb.inserts.length,
      update: updates.length,
      delete: deletes.length,
      same,
      samples: {
        insert: tb.inserts.slice(0, SAMPLE),
        delete: deletes.slice(0, SAMPLE),
        update: updates.slice(0, SAMPLE).map((u) => ({ src: u.src, dst: u.dst, changed: u.changed })),
      },
    };
    summary.push(res);
    ctx.item(p.name, { state: 'done', status: t('done'), insert: res.insert, update: res.update, delete: res.delete, same });
    ctx.log(`${p.name}: +${res.insert} ~${res.update} −${res.delete} =${same}`);
  }
  state.set(ctx.job.id, { src, dst, srcNs, dstNs, tables, at: Date.now() });
  for (const [k, v] of state) if (Date.now() - v.at > 60 * 60 * 1000) state.delete(k);
  return { tables: summary };
}

function plan(compareId, selection) {
  const st = state.get(compareId);
  if (!st) throw new Error(t('The comparison result has expired — compare again.'));
  const sel = new Map((selection || []).map((s) => [s.table, s]));
  const tables = st.tables.filter((tb) => sel.has(tb.table));
  if (!tables.length) throw new Error(t('No tables selected'));
  return { st, tables, sel };
}

function ops(st, t, actions) {
  const to = st.dst.type;
  const from = st.src.type;
  const T = qualified(to, st.dstNs, t.target);
  const dkinds = t.cols.map((c) => {
    const col = t.dm.columns.find((x) => x.name === c);
    return canonicalType(col ? col.type : mapType(t.sm.columns.find((x) => x.name === c).type, from, to), to).kind;
  });
  const keyIdx = t.key.map((k) => t.cols.indexOf(k));
  const conv = (row, i) => convertValue(row[i], dkinds[i], to);
  const where = (row, start) => ({
    sql: keyIdx.map((i, j) => `${q(to, t.key[j])} = ${placeholder(to, start + j)}`).join(' AND '),
    params: keyIdx.map((i) => conv(row, i)),
  });
  const out = { inserts: [], updates: [], deletes: [] };
  if (actions.insert) {
    out.inserts = t.inserts.map((r) => ({
      sql: `INSERT INTO ${T} (${t.cols.map((c) => q(to, c)).join(', ')}) VALUES (${t.cols.map((_, i) => placeholder(to, i + 1)).join(', ')})`,
      params: t.cols.map((_, i) => conv(r, i)),
      lit: () => `INSERT INTO ${T} (${t.cols.map((c) => q(to, c)).join(', ')}) VALUES (${t.cols.map((_, i) => literal(conv(r, i), to, dkinds[i])).join(', ')});`,
    }));
  }
  if (actions.update) {
    out.updates = t.updates.map((u) => {
      const w = where(u.dst, u.changed.length + 1);
      return {
        sql: `UPDATE ${T} SET ${u.changed.map((c, j) => `${q(to, t.cols[c])} = ${placeholder(to, j + 1)}`).join(', ')} WHERE ${w.sql}`,
        params: [...u.changed.map((c) => conv(u.src, c)), ...w.params],
        lit: () =>
          `UPDATE ${T} SET ${u.changed.map((c) => `${q(to, t.cols[c])} = ${literal(conv(u.src, c), to, dkinds[c])}`).join(', ')} WHERE ${keyIdx
            .map((i, j) => `${q(to, t.key[j])} = ${literal(conv(u.dst, i), to, dkinds[i])}`)
            .join(' AND ')};`,
      };
    });
  }
  if (actions.delete) {
    out.deletes = t.deletes.map((r) => {
      const w = where(r, 1);
      return {
        sql: `DELETE FROM ${T} WHERE ${w.sql}`,
        params: w.params,
        lit: () => `DELETE FROM ${T} WHERE ${keyIdx.map((i, j) => `${q(to, t.key[j])} = ${literal(conv(r, i), to, dkinds[i])}`).join(' AND ')};`,
      };
    });
  }
  return out;
}

function ordered(st, tables, sel) {
  const order = dependencyOrder(tables.map((t) => t.sm));
  const byName = new Map(tables.map((t) => [t.table, t]));
  const parentsFirst = order.map((m) => byName.get(m.name));
  return {
    upserts: parentsFirst.map((t) => ({ t, o: ops(st, t, { insert: sel.get(t.table).insert, update: sel.get(t.table).update }) })),
    deletes: [...parentsFirst].reverse().map((t) => ({ t, o: ops(st, t, { delete: sel.get(t.table).delete }) })),
  };
}

/** selection: [{ table, insert, update, delete }] */
export async function runApply(ctx, { compareId, selection }) {
  const { st, tables, sel } = plan(compareId, selection);
  const { upserts, deletes } = ordered(st, tables, sel);
  const total = [...upserts, ...deletes].reduce((s, x) => s + x.o.inserts.length + x.o.updates.length + x.o.deletes.length, 0);
  if (!total) return { applied: 0 };
  let done = 0;
  const run = async (list, label) => {
    for (let i = 0; i < list.length; i += 500) {
      ctx.checkCancel();
      const chunk = list.slice(i, i + 500);
      await db.transaction(st.dst, st.dstNs, async (s) => {
        for (const o of chunk) await s.exec(o.sql, o.params);
      });
      done += chunk.length;
      ctx.progress(done / total, `${label} — ${num(done)} / ${num(total)}`);
    }
  };
  for (const { t, o } of upserts) {
    await run(o.inserts, `INSERT ${t.target}`);
    await run(o.updates, `UPDATE ${t.target}`);
    ctx.log(`${t.target}: +${o.inserts.length} ~${o.updates.length}`);
  }
  for (const { t, o } of deletes) {
    await run(o.deletes, `DELETE ${t.target}`);
    if (o.deletes.length) ctx.log(`${t.target}: −${o.deletes.length}`);
  }
  state.delete(compareId);
  return { applied: done };
}

export async function runScript(ctx, { compareId, selection }) {
  const { st, tables, sel } = plan(compareId, selection);
  const { upserts, deletes } = ordered(st, tables, sel);
  const file = join(tmpdir(), `dbstudio-${ctx.job.id}.sql`);
  const fileName = `sync-${st.dstNs || 'db'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.sql`;
  ctx.setFile(file, fileName);
  const out = createWriteStream(file);
  const w = async (s) => {
    if (!out.write(s)) await once(out, 'drain');
  };
  let n = 0;
  try {
    await w(`-- DBStudio data synchronization script\n-- Target: ${st.dst.name || st.dst.type}${st.dstNs ? ' / ' + st.dstNs : ''}\n-- Generated: ${new Date().toISOString()}\n\n`);
    await w(st.dst.type === 'postgres' ? 'BEGIN;\n\n' : st.dst.type === 'mysql' ? 'START TRANSACTION;\n\n' : 'BEGIN TRANSACTION;\n\n');
    for (const { t: tb, o } of upserts) {
      if (!o.inserts.length && !o.updates.length) continue;
      await w(`-- ${tb.target}\n`);
      for (const x of [...o.inserts, ...o.updates]) {
        await w(x.lit() + '\n');
        n++;
      }
      await w('\n');
    }
    for (const { t: tb, o } of deletes) {
      if (!o.deletes.length) continue;
      await w(`-- ${t('{table} (delete)', { table: tb.target })}\n`);
      for (const x of o.deletes) {
        await w(x.lit() + '\n');
        n++;
      }
      await w('\n');
    }
    await w('COMMIT;\n');
  } finally {
    out.end();
    await once(out, 'close');
  }
  ctx.progress(1);
  return { statements: n, fileName };
}
