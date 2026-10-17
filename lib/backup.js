// One-click backup & restore with history, stored in ~/.dbstudio/backups/<connection id>/.
import { join, basename } from 'node:path';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createGzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { runDump, runImport } from './transfer.js';
import { dataDir } from './settings.js';
import { t } from './i18n.js';

const safe = (s) => String(s).replace(/[^\w.-]+/g, '_');
// DBSTUDIO_DATA_DIR lets tests (and portable installs) keep backups elsewhere.
const dirOf = (connId) => join(dataDir(), 'backups', safe(connId));

export function listBackups(connId) {
  const dir = dirOf(connId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const file = join(dir, meta.file);
        return existsSync(file) ? { ...meta, size: statSync(file).size } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function findBackup(connId, id) {
  const b = listBackups(connId).find((x) => x.id === id);
  if (!b) throw new Error(t('Backup not found'));
  return { meta: b, file: join(dirOf(connId), b.file) };
}

/** opts: { conn, ns, tables, note } */
export async function runBackup(ctx, opts) {
  const { conn, ns } = opts;
  const r = await runDump(ctx, { conn, ns, tables: opts.tables, structure: true, data: true, dropTable: true, views: true });
  const dir = dirOf(conn.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}-${safe(ns || 'db')}`;
  const file = `${id}.sql.gz`;
  ctx.progress(0.97, t('Compressing'));
  await pipeline(createReadStream(ctx.job.file), createGzip({ level: 6 }), createWriteStream(join(dir, file), { mode: 0o600 }));
  const meta = {
    id,
    file,
    connId: conn.id,
    connName: conn.name,
    type: conn.type,
    ns,
    tables: r.tables,
    views: r.views,
    rows: r.rows,
    note: String(opts.note || '').slice(0, 200),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
  ctx.log(t('Backup saved: {file}', { file }));
  return meta;
}

/** opts: { conn, ns (target), backupId, continueOnError } */
export async function runRestore(ctx, opts) {
  const { file, meta } = findBackup(opts.conn.id, opts.backupId);
  ctx.progress(0.01, t('Opening backup'));
  const sql = gunzipSync(readFileSync(file)).toString('utf8');
  const r = await runImport(ctx, { conn: opts.conn, ns: opts.ns || meta.ns, sql, continueOnError: Boolean(opts.continueOnError) });
  ctx.log(t('Restored from backup {date}', { date: meta.createdAt }));
  return r;
}

export function deleteBackup(connId, id) {
  const { file } = findBackup(connId, id);
  rmSync(file, { force: true });
  rmSync(join(dirOf(connId), `${id}.json`), { force: true });
  return { ok: true };
}

/** Copy the decompressed dump to a temp file for download. */
export function exportBackup(connId, id, outFile) {
  const { file, meta } = findBackup(connId, id);
  writeFileSync(outFile, gunzipSync(readFileSync(file)));
  return { fileName: `${basename(meta.file, '.gz')}` };
}
