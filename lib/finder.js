// "Find in database": find a value in every text-castable column of every table in a namespace.
import * as db from './drivers.js';
import { describeSchema, canonicalType } from './schema.js';
import { t } from './i18n.js';

const { q, qualified, placeholder } = db;

function castText(type, col) {
  if (type === 'postgres') return `${col}::text`;
  if (type === 'mysql') return `CAST(${col} AS CHAR)`;
  return `CAST(${col} AS TEXT)`;
}

/** opts: { conn, ns, term, match: 'contains'|'exact'|'starts', caseSensitive, tables: [names] | null, sampleRows } */
export async function runFind(ctx, opts) {
  const { conn, ns } = opts;
  const ty = conn.type;
  const term = String(opts.term ?? '');
  if (!term.trim()) throw new Error(t('Enter the text to search for'));
  const models = (await describeSchema(conn, ns, opts.tables?.length ? opts.tables : null)).filter((m) => m.kind === 'table' || opts.includeViews);
  const escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
  const match = opts.match || 'contains';
  const pattern = match === 'exact' ? term : match === 'starts' ? escLike(term) + '%' : '%' + escLike(term) + '%';
  const ci = !opts.caseSensitive;
  const results = [];
  let hits = 0;
  for (let i = 0; i < models.length; i++) {
    ctx.checkCancel();
    const m = models[i];
    ctx.progress(i / models.length, t('Searching {name}', { name: m.name }));
    const cols = m.columns.filter((c) => canonicalType(c.type, ty).kind !== 'blob');
    if (!cols.length) continue;
    const conds = [];
    const params = [];
    let p = 1;
    for (const c of cols) {
      let expr = castText(ty, q(ty, c.name));
      let ph = placeholder(ty, p++);
      if (ci) {
        expr = `LOWER(${expr})`;
        ph = `LOWER(${ph})`;
      }
      if (match === 'exact') conds.push(`${expr} = ${ph}`);
      else conds.push(`${expr} LIKE ${ph}${ty === 'mysql' ? '' : " ESCAPE '\\'"}`);
      params.push(pattern);
    }
    const where = conds.join(' OR ');
    const T = qualified(ty, ns, m.name);
    try {
      const n = Number((await db.raw(conn, `SELECT COUNT(*) FROM ${T} WHERE ${where}`, params)).rows[0][0]);
      if (!n) continue;
      const sample = await db.raw(conn, `SELECT * FROM ${T} WHERE ${where} LIMIT ${Math.min(Number(opts.sampleRows) || 20, 200)}`, params);
      const needle = ci ? term.toLowerCase() : term;
      const matchedCols = new Set();
      sample.rows.forEach((r) =>
        r.forEach((v, ci2) => {
          if (v == null) return;
          const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
          const hay = ci ? s.toLowerCase() : s;
          if (match === 'exact' ? hay === needle : match === 'starts' ? hay.startsWith(needle) : hay.includes(needle)) matchedCols.add(sample.columns[ci2]);
        }),
      );
      hits += n;
      results.push({ table: m.name, count: n, columns: sample.columns, rows: sample.rows, matched: [...matchedCols], where });
      ctx.item(m.name, { table: m.name, count: n, state: 'match', status: t('match') });
    } catch (e) {
      ctx.log(`${m.name}: ${e.message}`, 'warn');
    }
  }
  ctx.progress(1, t('Done'));
  // The WHERE clause is rebuilt in the UI with literals, so send the parameterised version only for display.
  return { term, match, caseSensitive: !ci, tables: models.length, hits, results: results.map(({ where, ...r }) => r) };
}
