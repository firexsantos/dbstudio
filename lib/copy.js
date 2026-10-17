// Copy tables (structure and/or data) to another database, schema, server — or another engine.
import * as db from './drivers.js';
import { t, plural, num } from './i18n.js';
import { describeSchema, createTableSQL, createViewSQL, canonicalType, mapType, translateDefault } from './schema.js';

const { q, qualified, placeholder } = db;

// Stream rows in chunks: keyset pagination on a single-column PK, OFFSET otherwise.
export async function* readRows(conn, ns, model, columns, chunk = 1000) {
  const ty = conn.type;
  const T = qualified(ty, ns, model.name);
  const colSql = columns.map((c) => q(ty, c)).join(', ');
  const pk = model.primaryKey || [];
  if (pk.length === 1 && columns.includes(pk[0])) {
    const k = q(ty, pk[0]);
    const ki = columns.indexOf(pk[0]);
    let last;
    for (;;) {
      const where = last === undefined ? '' : ` WHERE ${k} > ${placeholder(ty, 1)}`;
      const r = await db.raw(conn, `SELECT ${colSql} FROM ${T}${where} ORDER BY ${k} LIMIT ${chunk}`, last === undefined ? [] : [last]);
      if (!r.rows.length) return;
      yield r.rows;
      if (r.rows.length < chunk) return;
      last = r.rows[r.rows.length - 1][ki];
    }
  }
  const order = pk.length ? ` ORDER BY ${pk.map((c) => q(ty, c)).join(', ')}` : '';
  for (let off = 0; ; off += chunk) {
    const r = await db.raw(conn, `SELECT ${colSql} FROM ${T}${order} LIMIT ${chunk} OFFSET ${off}`);
    if (!r.rows.length) return;
    yield r.rows;
    if (r.rows.length < chunk) return;
  }
}

// Columns whose values can be inserted (generated columns are recomputed by the target).
export function insertableColumns(model, from, to) {
  return model.columns.filter((c) => !(c.generated && from === to)).map((c) => c.name);
}

// Convert a value read from `from` so the `to` driver stores it correctly in a column of `kind`.
export function convertValue(v, kind, to) {
  if (v == null) return null;
  if (kind === 'bool') {
    let b;
    if (typeof v === 'boolean') b = v;
    else if (typeof v === 'number') b = v !== 0;
    else b = ['1', 't', 'true', 'y', 'yes', 'on'].includes(String(v).trim().toLowerCase());
    return to === 'postgres' ? b : b ? 1 : 0;
  }
  if (v instanceof Uint8Array) return kind === 'blob' ? Buffer.from(v) : Buffer.from(v).toString('utf8');
  if (kind === 'json' && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'object' && !(Array.isArray(v) && to === 'postgres')) return JSON.stringify(v);
  if (to === 'mysql' && (kind === 'datetime' || kind === 'datetimetz') && typeof v === 'string') {
    return v.replace('T', ' ').replace(/([+-]\d\d(:?\d\d)?|Z)$/, '');
  }
  if (typeof v === 'boolean') return to === 'postgres' ? v : v ? 1 : 0;
  return v;
}

async function targetTables(conn, ns) {
  return new Set((await db.listTables(conn, ns)).map((ty) => ty.name));
}

async function dropTables(conn, ns, names, kind = 'TABLE') {
  if (!names.length) return;
  const ty = conn.type;
  await db.withSession(conn, ns, async (s) => {
    if (ty === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 0');
    if (ty === 'sqlite') await s.run('PRAGMA foreign_keys = OFF');
    try {
      for (const n of names) await s.run(`DROP ${kind} IF EXISTS ${qualified(ty, ns, n)}${ty === 'postgres' ? ' CASCADE' : ''}`);
    } finally {
      if (ty === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 1');
      if (ty === 'sqlite') await s.run('PRAGMA foreign_keys = ON');
    }
  });
}

async function resetIdentity(conn, ns, table, model) {
  if (conn.type !== 'postgres') return;
  const T = qualified('postgres', ns, table);
  for (const c of model.columns.filter((x) => x.autoIncrement)) {
    const col = q('postgres', c.name);
    await db.raw(
      conn,
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE(MAX(${col}), 1), 1), MAX(${col}) IS NOT NULL) FROM ${T}`,
      [T, c.name],
    );
  }
}

/**
 * opts: { src, srcNs, dst, dstNs, tables: [{ name, targetName }], views: [name], mode: 'both'|'structure'|'data',
 *         dropExisting, foreignKeys }
 */
export async function runCopy(ctx, opts) {
  const { src, srcNs, dst, dstNs, mode = 'both', dropExisting = false, foreignKeys = true } = opts;
  const tables = opts.tables || [];
  const views = opts.views || [];
  const from = src.type;
  const to = dst.type;
  const withStructure = mode !== 'data';
  const withData = mode !== 'structure';
  const sameServer = src.id === dst.id;
  if (sameServer && srcNs === dstNs && tables.some((tb) => (tb.targetName || tb.name) === tb.name)) {
    throw new Error(t('Source and target are the same. Give the target table a different name.'));
  }

  ctx.progress(0.01, t('Reading source structure'));
  const models = await describeSchema(src, srcNs, [...tables.map((tb) => tb.name), ...views]);
  const byName = new Map(models.map((m) => [m.name, m]));
  const renameMap = Object.fromEntries(tables.map((tb) => [tb.name, tb.targetName || tb.name]));
  const existing = await targetTables(dst, dstNs);

  const work = [];
  for (const tb of tables) {
    const m = byName.get(tb.name);
    if (!m || m.kind !== 'table') throw new Error(t('Source table not found: {name}', { name: tb.name }));
    const target = renameMap[tb.name];
    if (withStructure && existing.has(target) && !dropExisting) {
      throw new Error(t('Table "{name}" already exists in the target. Tick "Drop existing tables" or choose the "Data only" mode.', { name: target }));
    }
    if (!withStructure && !existing.has(target)) throw new Error(t('"Data only" mode: table "{name}" does not exist in the target.', { name: target }));
    let rows = 0;
    if (withData) rows = Number((await db.raw(src, `SELECT COUNT(*) FROM ${qualified(from, srcNs, tb.name)}`)).rows[0][0]);
    work.push({ m, target, rows });
    // `state` is the stable id the UI can compare; `status` is the translated label shown to the user.
    ctx.item(tb.name, { table: tb.name, target, rows, done: 0, state: 'waiting', status: t('waiting') });
  }
  const totalRows = work.reduce((a, w) => a + w.rows, 0);
  let doneRows = 0;
  const pct = (structPart) => 0.02 + (withStructure ? 0.13 * structPart : 0) + (withData ? 0.8 * (totalRows ? doneRows / totalRows : 1) : 0);
  ctx.log(t('{tables}, {rows} — {from} → {to}', { tables: plural(work.length, '{n} table', '{n} tables'), rows: plural(totalRows, '{n} row', '{n} rows'), from, to }));

  // ---- 1. structure ----
  if (withStructure) {
    if (dropExisting) {
      const toDrop = work.map((w) => w.target).filter((n) => existing.has(n));
      if (toDrop.length) {
        ctx.progress(pct(0), t('Dropping old tables'));
        await dropTables(dst, dstNs, toDrop);
        ctx.log(t('Dropped in the target: {names}', { names: toDrop.join(', ') }));
        for (const n of toDrop) existing.delete(n);
      }
    }
    const known = new Set([...existing, ...work.map((w) => w.target)]);
    for (let i = 0; i < work.length; i++) {
      ctx.checkCancel();
      const w = work[i];
      ctx.item(w.m.name, { state: 'structure', status: t('creating structure') });
      ctx.progress(pct(i / work.length), t('Creating {name}', { name: w.target }));
      const ddl = createTableSQL(w.m, to, {
        ns: dstNs,
        srcNs,
        from,
        name: w.target,
        renameMap,
        fkMode: to === 'sqlite' && foreignKeys ? 'inline' : 'none',
        fkFilter: (fk) => known.has(renameMap[fk.refTable] || fk.refTable),
      });
      await db.execScript(dst, dstNs, [ddl.create, ...ddl.indexes, ...ddl.comments], { transactional: false });
      if (from !== to) {
        const lossy = w.m.columns.filter(
          (c) => c.default != null && !c.autoIncrement && translateDefault(c.default, from, to, mapType(c.type, from, to)) == null,
        );
        if (lossy.length) ctx.log(t('{table}: default could not be translated for {columns}', { table: w.target, columns: lossy.map((c) => c.name).join(', ') }), 'warn');
      }
    }
    ctx.log(t('Structure created'));
  }

  // ---- 2. data ----
  if (withData) {
    if (to === 'sqlite') await db.raw(dst, 'PRAGMA foreign_keys = OFF');
    try {
      for (const w of work) {
        ctx.checkCancel();
        ctx.item(w.m.name, { state: 'data', status: t('copying data') });
        const cols = insertableColumns(w.m, from, to);
        if (!cols.length || !w.rows) {
          ctx.item(w.m.name, { state: 'done', status: t('done'), done: 0 });
          continue;
        }
        // Same server & engine: let the database move the rows itself.
        if (sameServer && from === to) {
          ctx.progress(pct(1), t('Copying {name}', { name: w.target }));
          const colSql = cols.map((c) => q(to, c)).join(', ');
          const n = await db.transaction(dst, dstNs, async (s) => {
            if (to === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 0');
            try {
              return await s.exec(`INSERT INTO ${qualified(to, dstNs, w.target)} (${colSql}) SELECT ${colSql} FROM ${qualified(from, srcNs, w.m.name)}`);
            } finally {
              if (to === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 1');
            }
          });
          doneRows += w.rows;
          ctx.item(w.m.name, { done: n, state: 'done', status: t('done') });
        } else {
          const targetTypes = new Map(w.m.columns.map((c) => [c.name, from === to ? c.type : mapType(c.type, from, to)]));
          const kinds = cols.map((c) => canonicalType(targetTypes.get(c), to).kind);
          let done = 0;
          for await (const chunk of readRows(src, srcNs, w.m, cols, 1000)) {
            ctx.checkCancel();
            const rows = chunk.map((r) => r.map((v, i) => convertValue(v, kinds[i], to)));
            await db.transaction(dst, dstNs, async (s) => {
              if (to === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 0');
              try {
                await db.insertRows(s, to, dstNs, w.target, cols, rows);
              } finally {
                if (to === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 1');
              }
            });
            done += rows.length;
            doneRows += rows.length;
            ctx.item(w.m.name, { done });
            ctx.progress(pct(1), t('Copying {name} ({done}/{total})', { name: w.target, done: num(done), total: num(w.rows) }));
          }
          ctx.item(w.m.name, { state: 'done', status: t('done') });
        }
        if (withStructure || to === 'postgres') await resetIdentity(dst, dstNs, w.target, w.m).catch(() => {});
      }
    } finally {
      if (to === 'sqlite') await db.raw(dst, 'PRAGMA foreign_keys = ON').catch(() => {});
    }
    ctx.log(plural(doneRows, '{n} row copied', '{n} rows copied'));
  }

  // ---- 3. foreign keys (MySQL / PostgreSQL add them after the data is in) ----
  if (withStructure && foreignKeys && to !== 'sqlite') {
    ctx.progress(0.96, t('Creating relations (foreign keys)'));
    const present = await targetTables(dst, dstNs);
    for (const w of work) {
      const { foreignKeys: stmts } = createTableSQL(w.m, to, {
        ns: dstNs,
        srcNs,
        from,
        name: w.target,
        renameMap,
        fkMode: 'alter',
        fkFilter: (fk) => present.has(renameMap[fk.refTable] || fk.refTable),
      });
      for (const st of stmts) {
        try {
          await db.raw(dst, st);
        } catch (e) {
          ctx.log(t('Relation on {table} failed: {error}', { table: w.target, error: e.message }), 'warn');
        }
      }
      const skipped = w.m.foreignKeys.length - stmts.length;
      if (skipped > 0) ctx.log(t('{table}: {count} skipped (referenced table not in the target)', { table: w.target, count: plural(skipped, '{n} relation', '{n} relations') }), 'warn');
    }
  }

  // ---- 4. views ----
  for (const v of views) {
    const m = byName.get(v);
    if (!m || m.kind !== 'view') continue;
    try {
      if (dropExisting) await dropTables(dst, dstNs, [v], 'VIEW');
      await db.raw(dst, createViewSQL(m, to, { ns: dstNs, from }), [], dstNs);
      ctx.log(t('View {name} created', { name: v }));
    } catch (e) {
      ctx.log(from !== to ? t('View {name} failed (view SQL may not be portable across engines): {error}', { name: v, error: e.message }) : t('View {name} failed: {error}', { name: v, error: e.message }), 'warn');
    }
  }

  ctx.progress(1, t('Done'));
  return { tables: work.length, rows: doneRows };
}
