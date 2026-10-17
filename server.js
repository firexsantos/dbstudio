#!/usr/bin/env node
// DBStudio — local database manager (MySQL/MariaDB, PostgreSQL, SQLite).
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { platform, release } from 'node:os';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import * as store from './lib/store.js';
import * as db from './lib/drivers.js';
import * as schema from './lib/schema.js';
import * as jobs from './lib/jobs.js';
import { runCopy } from './lib/copy.js';
import { runDump, runTableExport, runImport } from './lib/transfer.js';
import * as connio from './lib/connio.js';
import { runCompare as runDataCompare, runApply as runDataApply, runScript as runDataScript } from './lib/datasync.js';
import { planTable, runGenerate, sampleValues, generatorList } from './lib/datagen.js';
import { runFind } from './lib/finder.js';
import { buildDictionary } from './lib/dictionary.js';
import { listBackups, runBackup, runRestore, deleteBackup, exportBackup } from './lib/backup.js';
import { buildXlsx } from './lib/xlsx.js';
import * as settings from './lib/settings.js';
import { t, plural } from './lib/i18n.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const require = createRequire(import.meta.url);
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// Inside the packaged app the bundled files are read-only, so Electron points this at a writable copy.
const DEMO_FILE = process.env.DBSTUDIO_DEMO_FILE || join(ROOT, 'demo', 'toko.db');

const app = express();
app.disable('x-powered-by');

// This server can run arbitrary SQL, so only this machine's own UI may talk to it:
// - Host must be localhost (blocks DNS-rebinding from a malicious website). An SSH port-forward
//   still works because the browser sends Host: localhost:<port>.
// - API calls must carry a custom header (cross-site pages cannot send it without CORS, which we never grant)
// Any port is accepted so `ssh -L 8080:localhost:5174 server` also works.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
app.use((req, res, next) => {
  if (!LOCAL_HOST.test(req.headers.host || '')) return res.status(403).send('Forbidden host');
  if (req.path.startsWith('/api/') && req.get('X-DBStudio') !== '1') {
    return res.status(403).json({ error: 'Missing X-DBStudio header' });
  }
  // Everything the UI needs is served from this origin; inline styles are used for dynamic layout.
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; " +
      "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// ---------- static assets ----------
// The page is stamped with the saved language/theme so the UI renders in the right one from the first frame.
const INDEX_FILE = join(ROOT, 'public', 'index.html');
const sendIndex = (_req, res) => {
  const s = settings.get();
  const html = readFileSync(INDEX_FILE, 'utf8').replace(/<html lang="[^"]*">/, `<html lang="${s.language}"${s.theme ? ` data-theme="${s.theme}"` : ''}>`);
  res.set('Cache-Control', 'no-store').type('html').send(html);
};
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(join(ROOT, 'public'), { index: false }));
app.use('/vendor/codemirror', express.static(join(ROOT, 'node_modules', 'codemirror')));
for (const [route, pkg] of [
  ['inter', '@fontsource-variable/inter'],
  ['space-grotesk', '@fontsource-variable/space-grotesk'],
  ['jetbrains-mono', '@fontsource-variable/jetbrains-mono'],
]) {
  app.use(`/vendor/fonts/${route}`, express.static(join(ROOT, 'node_modules', pkg), { maxAge: '7d' }));
}

// Lucide icon data as an ES module (generated once, gzipped).
const iconsModule = (() => {
  const { icons } = require('lucide/dist/umd/lucide.js');
  const src = `export const ICONS = ${JSON.stringify(icons)};\n`;
  return { src, gz: gzipSync(src) };
})();
app.get('/vendor/icons.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'public, max-age=86400');
  if (/\bgzip\b/.test(req.get('accept-encoding') || '')) res.set('Content-Encoding', 'gzip').send(iconsModule.gz);
  else res.send(iconsModule.src);
});

// ---------- JSON helpers ----------
const json = express.json({ limit: '64mb' });

// JSON that survives BigInt, Buffers and binary columns.
function send(res, payload) {
  const body = JSON.stringify(payload, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return `0x${Buffer.from(v.data).toString('hex')}`;
    if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex')}`;
    return v;
  });
  res.type('application/json').send(body);
}

const route = (fn) => async (req, res) => {
  try {
    send(res, await fn(req, res));
  } catch (err) {
    res.status(400).json({ error: err.message || String(err), code: err.code || null });
  }
};

function connOr404(id) {
  const conn = store.get(id);
  if (!conn) throw Object.assign(new Error(t('Connection not found')), { code: 'NOT_FOUND' });
  return conn;
}
const C = (req) => connOr404(req.params.id);

// ---------- connections ----------

app.get('/api/connections', route(() => store.list().map(store.redact)));

app.post(
  '/api/connections',
  json,
  route(async (req) => {
    const { copyPasswordFrom, hasPassword, ...raw } = req.body;
    let body = raw;
    if (body.ssh) {
      const { hasPassword: _a, hasPassphrase: _b, ...ssh } = body.ssh;
      body.ssh = ssh;
    }
    if (body.id) body = store.mergeSecrets(body, store.get(body.id));
    if (copyPasswordFrom) body = store.mergeSecrets(body, store.get(copyPasswordFrom));
    if (body.id) await db.disconnect(body.id);
    return store.redact(store.save(body));
  }),
);

app.delete(
  '/api/connections/:id',
  route(async (req) => {
    await db.disconnect(req.params.id);
    store.remove(req.params.id);
    return { ok: true };
  }),
);

app.post(
  '/api/connections/test',
  json,
  route(async (req) => {
    let body = { ...req.body };
    if (body.id) body = store.mergeSecrets(body, store.get(body.id));
    return db.test(body);
  }),
);

app.post(
  '/api/c/:id/connect',
  route(async (req) => {
    const conn = C(req);
    const namespaces = await db.listNamespaces(conn);
    store.patch(conn.id, { lastUsed: Date.now() });
    const info = await db.serverInfo(conn).catch(() => ({ version: null, flavor: conn.type }));
    const defaultNs = conn.type === 'postgres' ? (namespaces.includes('public') ? 'public' : namespaces[0]) : conn.database || namespaces[0];
    return { namespaces, label: db.NAMESPACE_LABEL[conn.type], defaultNs, version: info.version, flavor: info.flavor };
  }),
);

app.post('/api/c/:id/disconnect', route(async (req) => (await db.disconnect(req.params.id), { ok: true })));

// Bundled demo database so the app can be tried without a running DB server.
app.get('/api/demo', route(() => ({ file: DEMO_FILE, exists: existsSync(DEMO_FILE) })));

app.get(
  '/api/meta',
  route(() => ({
    version: PKG.version,
    runtime: process.versions.electron ? t('Desktop app (Electron {version})', { version: process.versions.electron }) : `Node.js ${process.versions.node}`,
    platform: `${platform() === 'linux' ? 'Linux' : platform()} ${release().split('-')[0]}`,
  })),
);

// ---------- preferences ----------
app.get('/api/settings', route(() => ({ ...settings.get(), dataDir: settings.dataDir() })));
app.post('/api/settings', json, route((req) => ({ ...settings.set(req.body || {}), dataDir: settings.dataDir() })));

// ---------- metadata ----------

app.get('/api/c/:id/namespaces', route((req) => db.listNamespaces(C(req))));
app.get('/api/c/:id/tables', route((req) => db.listTables(C(req), req.query.ns)));
app.get('/api/c/:id/objects', route((req) => db.listObjects(C(req), req.query.ns)));
app.get(
  '/api/c/:id/object-def',
  route(async (req) => ({ sql: await db.objectDefinition(C(req), req.query.ns, req.query.kind, req.query.name, req.query.oid) })),
);
app.get('/api/c/:id/columns', route((req) => db.listColumns(C(req), req.query.ns, req.query.table)));
app.get('/api/c/:id/all-columns', route((req) => db.allColumns(C(req), req.query.ns)));
app.get('/api/c/:id/ddl', route(async (req) => ({ ddl: await schema.tableDDL(C(req), req.query.ns, req.query.table) })));
app.get('/api/c/:id/describe', route((req) => schema.describeTable(C(req), req.query.ns, req.query.table)));
app.get('/api/c/:id/schema', route((req) => schema.describeSchema(C(req), req.query.ns)));
app.get('/api/c/:id/charsets', route((req) => db.charsets(C(req))));

// ---------- data ----------

app.get(
  '/api/c/:id/data',
  route((req) => {
    const { ns, table, limit, offset, orderBy, dir, filter } = req.query;
    return db.tableData(C(req), ns, table, { limit, offset, orderBy, dir, filter });
  }),
);
app.post('/api/c/:id/query', json, route((req) => db.raw(C(req), String(req.body.sql || ''), [], req.body.ns || null)));
app.post('/api/c/:id/apply', json, route((req) => db.applyChanges(C(req), req.body.ns, req.body.table, req.body.ops)));
app.post(
  '/api/c/:id/bulk-insert',
  json,
  route(async (req) => ({ inserted: await db.bulkInsert(C(req), req.body.ns, req.body.table, req.body.columns, req.body.rows) })),
);

// Run reviewed DDL (from the designer / dialogs after the user saw the SQL preview).
app.post(
  '/api/c/:id/script',
  json,
  route(async (req) => {
    const statements = Array.isArray(req.body.statements) ? req.body.statements.map(String).filter((s) => s.trim()) : [];
    if (!statements.length) throw new Error(t('No statements to run'));
    try {
      return await db.execScript(C(req), req.body.ns || null, statements, { continueOnError: Boolean(req.body.continueOnError) });
    } catch (e) {
      throw Object.assign(new Error(e.failedSql ? `${e.message}\n\nStatement: ${e.failedSql.slice(0, 400)}` : e.message), { code: e.code });
    }
  }),
);

// ---------- SQL generators (preview before running) ----------

app.post(
  '/api/c/:id/sql/create-table',
  json,
  route((req) => {
    const conn = C(req);
    const model = req.body.model;
    if (!model?.name) throw new Error(t('Table name is required'));
    if (!model.columns?.length) throw new Error(t('Add at least one column'));
    return { statements: schema.createTableStatements(model, conn.type, { ns: req.body.ns, srcNs: req.body.ns, fkMode: 'inline' }) };
  }),
);
app.post(
  '/api/c/:id/sql/alter-table',
  json,
  route(async (req) => {
    const conn = C(req);
    const old = await schema.describeTable(conn, req.body.ns, req.body.table);
    return schema.alterTableSQL(old, req.body.model, conn.type, req.body.ns);
  }),
);
app.post('/api/c/:id/sql/namespace', json, route((req) => ({ statements: schema.namespaceSQL(C(req).type, req.body.action, req.body) })));
app.post(
  '/api/c/:id/sql/table-op',
  json,
  route((req) => ({ statements: schema.tableOpSQL(C(req).type, req.body.ns, req.body.op, req.body.table, req.body) })),
);
app.post('/api/c/:id/sql/user', json, route((req) => ({ statements: schema.userSQL(C(req).type, req.body.action, req.body) })));

// ---------- server tools ----------

app.get('/api/c/:id/server/processes', route((req) => db.processList(C(req))));
app.post('/api/c/:id/server/kill', json, route((req) => db.killProcess(C(req), req.body.pid, req.body.mode)));
app.get('/api/c/:id/server/variables', route((req) => db.serverVariables(C(req))));
app.get('/api/c/:id/server/status', route((req) => db.serverStatus(C(req))));
app.get('/api/c/:id/server/users', route((req) => db.listUsers(C(req))));
app.get('/api/c/:id/server/grants', route(async (req) => ({ grants: await db.userGrants(C(req), req.query.user, req.query.host) })));

// ---------- schema compare ----------

app.post(
  '/api/compare',
  json,
  route((req) =>
    schema.compareSchemas(connOr404(req.body.srcId), req.body.srcNs, connOr404(req.body.dstId), req.body.dstNs, {
      includeDrops: Boolean(req.body.includeDrops),
    }),
  ),
);

// ---------- background jobs ----------

app.post(
  '/api/jobs/copy',
  json,
  route((req) => {
    const b = req.body;
    const src = connOr404(b.srcId);
    const dst = connOr404(b.dstId);
    const n = (b.tables || []).length;
    const job = jobs.createJob('copy', plural(n, 'Copy {n} table → {target}', 'Copy {n} tables → {target}', { target: dst.name + (b.dstNs && dst.type !== 'sqlite' ? ' / ' + b.dstNs : '') }), (ctx) =>
      runCopy(ctx, { ...b, src, dst }),
    );
    return jobs.publicJob(job);
  }),
);
app.post(
  '/api/jobs/dump',
  json,
  route((req) => {
    const conn = connOr404(req.body.connId);
    const job = jobs.createJob('dump', t('SQL export {target}', { target: conn.name + (req.body.ns ? ' / ' + req.body.ns : '') }), (ctx) => runDump(ctx, { ...req.body, conn }));
    return jobs.publicJob(job);
  }),
);
app.post(
  '/api/jobs/export-table',
  json,
  route((req) => {
    const conn = connOr404(req.body.connId);
    const job = jobs.createJob('export', t('Export {table} ({format})', { table: req.body.table, format: String(req.body.format || 'csv').toUpperCase() }), (ctx) =>
      runTableExport(ctx, { ...req.body, conn }),
    );
    return jobs.publicJob(job);
  }),
);
app.post(
  '/api/jobs/import-sql',
  express.text({ limit: '512mb', type: () => true }),
  route((req) => {
    const conn = connOr404(req.query.connId);
    const sql = typeof req.body === 'string' ? req.body : '';
    if (!sql.trim()) throw new Error(t('The SQL file is empty'));
    const job = jobs.createJob('import', t('SQL import into {target}', { target: conn.name + (req.query.ns ? ' / ' + req.query.ns : '') }), (ctx) =>
      runImport(ctx, { conn, ns: req.query.ns || null, sql, continueOnError: req.query.continueOnError === '1' }),
    );
    return jobs.publicJob(job);
  }),
);
app.get('/api/jobs', route(() => jobs.listJobs()));
app.get(
  '/api/jobs/:jobId',
  route((req) => {
    const j = jobs.getJob(req.params.jobId);
    if (!j) throw new Error(t('Job not found'));
    return jobs.publicJob(j);
  }),
);
app.post('/api/jobs/:jobId/cancel', route((req) => ({ ok: jobs.cancelJob(req.params.jobId) })));

// ---------- connection management ----------

app.post('/api/connections/patch', json, route((req) => store.patch(req.body.ids, req.body.fields).map(store.redact)));
app.post('/api/connections/group-rename', json, route((req) => (store.renameGroup(req.body.from, req.body.to), { ok: true })));
app.post(
  '/api/connections/export',
  json,
  route((req) => {
    const ids = new Set(req.body.ids || []);
    const conns = store.list().filter((c) => !ids.size || ids.has(c.id));
    if (!conns.length) throw new Error(t('No connections to export'));
    return { content: connio.exportConnections(conns, { includePasswords: Boolean(req.body.includePasswords), passphrase: String(req.body.passphrase || '') }), count: conns.length };
  }),
);
app.post(
  '/api/connections/import/preview',
  express.json({ limit: '20mb' }),
  route((req) => {
    const s = connio.startImport(req.body);
    const existing = store.list();
    return {
      id: s.id,
      source: s.source,
      items: s.items.map((it) => ({ ...connio.previewItem(it), duplicate: !it.skip && existing.some((e) => connio.sameTarget(e, it.conn)) })),
    };
  }),
);
app.post(
  '/api/connections/import/commit',
  json,
  route((req) => {
    const s = connio.takeImport(req.body.id);
    const pickIdx = new Set(req.body.indices || []);
    const group = String(req.body.group || '').trim();
    const items = s.items
      .filter((it, i) => pickIdx.has(i) && !it.skip)
      .map((it) => ({ ...it.conn, ...(group ? { group } : {}) }));
    return { imported: store.addMany(items).length };
  }),
);

// ---------- data sync ----------

app.post(
  '/api/jobs/datasync/compare',
  json,
  route((req) => {
    const src = connOr404(req.body.srcId);
    const dst = connOr404(req.body.dstId);
    return jobs.publicJob(jobs.createJob('datasync', t('Compare data → {name}', { name: dst.name }), (ctx) => runDataCompare(ctx, { ...req.body, src, dst })));
  }),
);
app.post(
  '/api/jobs/datasync/apply',
  json,
  route((req) => jobs.publicJob(jobs.createJob('datasync', t('Sync data'), (ctx) => runDataApply(ctx, req.body)))),
);
app.post(
  '/api/jobs/datasync/script',
  json,
  route((req) => jobs.publicJob(jobs.createJob('export', t('Data sync script'), (ctx) => runDataScript(ctx, req.body)))),
);

// ---------- data generator ----------

app.get('/api/datagen/generators', route(() => generatorList()));
app.get('/api/c/:id/datagen/plan', route((req) => planTable(C(req), req.query.ns, req.query.table)));
app.post('/api/datagen/sample', json, route((req) => ({ values: sampleValues(req.body.spec || {}, 5) })));
app.post(
  '/api/jobs/datagen',
  json,
  route((req) => {
    const conn = connOr404(req.body.connId);
    const n = (req.body.tables || []).reduce((s, tb) => s + Number(tb.rows || 0), 0);
    return jobs.publicJob(jobs.createJob('datagen', plural(n, 'Generate {n} row', 'Generate {n} rows'), (ctx) => runGenerate(ctx, { ...req.body, conn })));
  }),
);

// ---------- find in database ----------

app.post(
  '/api/jobs/find',
  json,
  route((req) => {
    const conn = connOr404(req.body.connId);
    return jobs.publicJob(jobs.createJob('find', t('Find "{term}"', { term: String(req.body.term).slice(0, 40) }), (ctx) => runFind(ctx, { ...req.body, conn })));
  }),
);

// ---------- documentation & files ----------

app.get(
  '/api/c/:id/dictionary',
  route(async (req) => {
    const conn = C(req);
    return buildDictionary(conn, req.query.ns, { format: req.query.format === 'md' ? 'md' : 'html' });
  }),
);
app.post('/api/xlsx', express.json({ limit: '256mb' }), (req, res) => {
  try {
    const buf = buildXlsx(req.body.columns || [], req.body.rows || [], req.body.sheet || 'Data');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- backup & restore ----------

app.get('/api/c/:id/backups', route((req) => listBackups(C(req).id)));
app.post(
  '/api/c/:id/backups',
  json,
  route((req) => {
    const conn = C(req);
    return jobs.publicJob(jobs.createJob('backup', t('Backup {target}', { target: conn.name + (req.body.ns && conn.type !== 'sqlite' ? ' / ' + req.body.ns : '') }), (ctx) => runBackup(ctx, { ...req.body, conn })));
  }),
);
app.post(
  '/api/c/:id/backups/:bid/restore',
  json,
  route((req) => {
    const conn = C(req);
    return jobs.publicJob(jobs.createJob('restore', t('Restore into {name}', { name: conn.name }), (ctx) => runRestore(ctx, { ...req.body, conn, backupId: req.params.bid })));
  }),
);
app.delete('/api/c/:id/backups/:bid', route((req) => deleteBackup(C(req).id, req.params.bid)));
app.post(
  '/api/c/:id/backups/:bid/download',
  route((req) => {
    const conn = C(req);
    return jobs.publicJob(
      jobs.createJob('export', t('Download backup'), (ctx) => {
        const file = join(tmpdir(), `dbstudio-${ctx.job.id}.sql`);
        const r = exportBackup(conn.id, req.params.bid, file);
        ctx.setFile(file, r.fileName);
        return r;
      }),
    );
  }),
);

// File download for finished export jobs. A plain <a href> cannot send X-DBStudio, so a per-job
// random token authorizes the download instead.
app.get('/download/:jobId', (req, res) => {
  const j = jobs.getJob(req.params.jobId);
  const token = String(req.query.token || '');
  const ok =
    j && j.file && j.status === 'done' && token.length === j.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(j.token));
  if (!ok) return res.status(404).send('Not found');
  res.download(j.file, j.fileName);
});

// ---------- lifecycle ----------

/** Start listening on 127.0.0.1. port 0 picks a free port (used by the desktop app). */
export function startServer({ port = Number(process.env.PORT) || 5174 } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, () => resolve({ server, port: server.address().port }));
    server.once('error', reject);
  });
}

export async function stopServer(server) {
  await db.shutdown();
  await new Promise((r) => server.close(r));
}

// `node server.js` / `npm start`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, port } = await startServer();
  console.log(`\n  DBStudio running at http://localhost:${port}\n  (listening on ${HOST} only — not reachable from other machines)\n`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await stopServer(server);
      process.exit(0);
    });
  }
}
