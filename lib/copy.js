// Copy tables (structure and/or data) to another database, schema, server — or another engine.
import * as db from './drivers.js';
import { describeSchema, createTableSQL, createViewSQL, canonicalType, mapType, translateDefault } from './schema.js';

const { q, qualified, placeholder } = db;

// Stream rows in chunks: keyset pagination on a single-column PK, OFFSET otherwise.
export async function* readRows(conn, ns, model, columns, chunk = 1000) {
  const t = conn.type;
  const T = qualified(t, ns, model.name);
  const colSql = columns.map((c) => q(t, c)).join(', ');
  const pk = model.primaryKey || [];
  if (pk.length === 1 && columns.includes(pk[0])) {
    const k = q(t, pk[0]);
    const ki = columns.indexOf(pk[0]);
    let last;
    for (;;) {
      const where = last === undefined ? '' : ` WHERE ${k} > ${placeholder(t, 1)}`;
      const r = await db.raw(conn, `SELECT ${colSql} FROM ${T}${where} ORDER BY ${k} LIMIT ${chunk}`, last === undefined ? [] : [last]);
      if (!r.rows.length) return;
      yield r.rows;
      if (r.rows.length < chunk) return;
      last = r.rows[r.rows.length - 1][ki];
    }
  }
  const order = pk.length ? ` ORDER BY ${pk.map((c) => q(t, c)).join(', ')}` : '';
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
  return new Set((await db.listTables(conn, ns)).map((t) => t.name));
}

async function dropTables(conn, ns, names, kind = 'TABLE') {
  if (!names.length) return;
  const t = conn.type;
  await db.withSession(conn, ns, async (s) => {
    if (t === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 0');
    if (t === 'sqlite') await s.run('PRAGMA foreign_keys = OFF');
    try {
      for (const n of names) await s.run(`DROP ${kind} IF EXISTS ${qualified(t, ns, n)}${t === 'postgres' ? ' CASCADE' : ''}`);
    } finally {
      if (t === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 1');
      if (t === 'sqlite') await s.run('PRAGMA foreign_keys = ON');
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
  if (sameServer && srcNs === dstNs && tables.some((t) => (t.targetName || t.name) === t.name)) {
    throw new Error('Sumber dan tujuan sama. Beri nama tabel tujuan yang berbeda.');
  }

  ctx.progress(0.01, 'Membaca struktur sumber');
  const models = await describeSchema(src, srcNs, [...tables.map((t) => t.name), ...views]);
  const byName = new Map(models.map((m) => [m.name, m]));
  const renameMap = Object.fromEntries(tables.map((t) => [t.name, t.targetName || t.name]));
  const existing = await targetTables(dst, dstNs);

  const work = [];
  for (const t of tables) {
    const m = byName.get(t.name);
    if (!m || m.kind !== 'table') throw new Error(`Tabel sumber tidak ditemukan: ${t.name}`);
    const target = renameMap[t.name];
    if (withStructure && existing.has(target) && !dropExisting) {
      throw new Error(`Tabel "${target}" sudah ada di tujuan. Centang "Hapus tabel yang sudah ada" atau pilih mode "Data saja".`);
    }
    if (!withStructure && !existing.has(target)) throw new Error(`Mode "Data saja": tabel "${target}" tidak ada di tujuan.`);
    let rows = 0;
    if (withData) rows = Number((await db.raw(src, `SELECT COUNT(*) FROM ${qualified(from, srcNs, t.name)}`)).rows[0][0]);
    work.push({ m, target, rows });
    ctx.item(t.name, { table: t.name, target, rows, done: 0, status: 'menunggu' });
  }
  const totalRows = work.reduce((a, w) => a + w.rows, 0);
  let doneRows = 0;
  const pct = (structPart) => 0.02 + (withStructure ? 0.13 * structPart : 0) + (withData ? 0.8 * (totalRows ? doneRows / totalRows : 1) : 0);
  ctx.log(`${work.length} tabel, ${totalRows.toLocaleString('id-ID')} baris — ${from} → ${to}`);

  // ---- 1. structure ----
  if (withStructure) {
    if (dropExisting) {
      const toDrop = work.map((w) => w.target).filter((n) => existing.has(n));
      if (toDrop.length) {
        ctx.progress(pct(0), 'Menghapus tabel lama');
        await dropTables(dst, dstNs, toDrop);
        ctx.log(`Dihapus di tujuan: ${toDrop.join(', ')}`);
        for (const n of toDrop) existing.delete(n);
      }
    }
    const known = new Set([...existing, ...work.map((w) => w.target)]);
    for (let i = 0; i < work.length; i++) {
      ctx.checkCancel();
      const w = work[i];
      ctx.item(w.m.name, { status: 'membuat struktur' });
      ctx.progress(pct(i / work.length), `Membuat ${w.target}`);
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
        if (lossy.length) ctx.log(`${w.target}: default tidak bisa diterjemahkan untuk ${lossy.map((c) => c.name).join(', ')}`, 'warn');
      }
    }
    ctx.log('Struktur dibuat');
  }

  // ---- 2. data ----
  if (withData) {
    if (to === 'sqlite') await db.raw(dst, 'PRAGMA foreign_keys = OFF');
    try {
      for (const w of work) {
        ctx.checkCancel();
        ctx.item(w.m.name, { status: 'menyalin data' });
        const cols = insertableColumns(w.m, from, to);
        if (!cols.length || !w.rows) {
          ctx.item(w.m.name, { status: 'selesai', done: 0 });
          continue;
        }
        // Same server & engine: let the database move the rows itself.
        if (sameServer && from === to) {
          ctx.progress(pct(1), `Menyalin ${w.target}`);
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
          ctx.item(w.m.name, { done: n, status: 'selesai' });
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
            ctx.progress(pct(1), `Menyalin ${w.target} (${done.toLocaleString('id-ID')}/${w.rows.toLocaleString('id-ID')})`);
          }
          ctx.item(w.m.name, { status: 'selesai' });
        }
        if (withStructure || to === 'postgres') await resetIdentity(dst, dstNs, w.target, w.m).catch(() => {});
      }
    } finally {
      if (to === 'sqlite') await db.raw(dst, 'PRAGMA foreign_keys = ON').catch(() => {});
    }
    ctx.log(`${doneRows.toLocaleString('id-ID')} baris disalin`);
  }

  // ---- 3. foreign keys (MySQL / PostgreSQL add them after the data is in) ----
  if (withStructure && foreignKeys && to !== 'sqlite') {
    ctx.progress(0.96, 'Membuat relasi (foreign key)');
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
          ctx.log(`Relasi di ${w.target} gagal: ${e.message}`, 'warn');
        }
      }
      const skipped = w.m.foreignKeys.length - stmts.length;
      if (skipped > 0) ctx.log(`${w.target}: ${skipped} relasi dilewati (tabel rujukan tidak ada di tujuan)`, 'warn');
    }
  }

  // ---- 4. views ----
  for (const v of views) {
    const m = byName.get(v);
    if (!m || m.kind !== 'view') continue;
    try {
      if (dropExisting) await dropTables(dst, dstNs, [v], 'VIEW');
      await db.raw(dst, createViewSQL(m, to, { ns: dstNs, from }), [], dstNs);
      ctx.log(`View ${v} dibuat`);
    } catch (e) {
      ctx.log(`View ${v} gagal${from !== to ? ' (SQL view mungkin tidak portabel antar engine)' : ''}: ${e.message}`, 'warn');
    }
  }

  ctx.progress(1, 'Selesai');
  return { tables: work.length, rows: doneRows };
}
