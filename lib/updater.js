// Updates: check GitHub Releases for a newer DBStudio, download the installer that matches this install,
// verify it against the release's SHA256SUMS.txt, and install it.
//
// What "install" means depends on how DBStudio runs:
//  - .deb (Linux desktop)  → pkexec apt-get install <file> (graphical password prompt), then relaunch
//  - AppImage              → replace the running AppImage file, then relaunch
//  - Windows (.exe)        → start the NSIS installer and quit, so it can replace the app
//  - from source (npm start) → no self-install; the UI links to the release page instead
// The desktop app hands us its relaunch/quit/open hooks through globalThis.__dbstudioDesktop (electron/main.mjs).
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, copyFileSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir } from './settings.js';
import { t, num } from './i18n.js';

const REPO = 'firexsantos/dbstudio';
const apiUrl = () => process.env.DBSTUDIO_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_MS = 30 * 60 * 1000;
const UA = { 'User-Agent': 'DBStudio-Updater', Accept: 'application/vnd.github+json' };

let cache = null; // { at, info }
let ready = null; // { version, kind, file } — a verified download waiting to be installed

const desktop = () => globalThis.__dbstudioDesktop || null;

/** How this copy of DBStudio was installed: 'deb' | 'appimage' | 'exe' | null (running from source). */
export function installKind(env = process.env, platform = process.platform, isDesktop = Boolean(desktop())) {
  if (!isDesktop) return null;
  if (platform === 'win32') return 'exe';
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : 'deb';
  return null;
}

/** Compare dotted versions ("v0.4.10" > "0.4.9"); returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

const ARCH = { x64: ['amd64', 'x86_64'], arm64: ['arm64', 'aarch64'] };
/** Pick the release asset for this install kind and CPU. */
export function pickAsset(assets, kind, arch = process.arch) {
  const [debArch, imgArch] = ARCH[arch] || ARCH.x64;
  const want = {
    deb: (n) => n.endsWith(`-${debArch}.deb`),
    appimage: (n) => n.endsWith(`-${imgArch}.AppImage`),
    exe: (n) => /-Setup-.*\.exe$/i.test(n),
  }[kind];
  return want ? assets.find((a) => want(a.name)) || null : null;
}

/** Parse "sha256  file" lines. */
export function parseSums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

// Downloads only come from GitHub (or the test server named in DBSTUDIO_UPDATE_URL).
function allowedUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (process.env.DBSTUDIO_UPDATE_URL && url.host === new URL(process.env.DBSTUDIO_UPDATE_URL).host) return true;
  return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'));
}

/** Look for a newer release. Cached for 30 minutes unless `force`. */
export async function checkForUpdate(current, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return { ...cache.info, current };
  const res = await fetch(apiUrl(), { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(t('Could not check for updates (GitHub answered {status}).', { status: res.status }));
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/i, '');
  const kind = installKind();
  const assets = (rel.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
  const asset = pickAsset(assets, kind);
  const info = {
    current,
    latest,
    available: Boolean(latest) && compareVersions(latest, current) > 0,
    name: rel.name || `DBStudio ${latest}`,
    notes: String(rel.body || ''),
    url: rel.html_url || `https://github.com/${REPO}/releases/latest`,
    publishedAt: rel.published_at || null,
    kind,
    asset: asset ? { name: asset.name, size: asset.size } : null,
    canInstall: Boolean(kind && asset && assets.some((a) => a.name === 'SHA256SUMS.txt')),
    ready: ready?.version === latest,
  };
  cache = { at: Date.now(), info, assets };
  return info;
}

/** Background job: download the installer for this install and verify its checksum. */
export async function runDownload(ctx, current) {
  const info = await checkForUpdate(current);
  if (!info.available) throw new Error(t('DBStudio is already up to date.'));
  if (!info.canInstall) throw new Error(t('This copy of DBStudio cannot update itself — download the new version from the release page.'));
  const assets = cache.assets;
  const asset = pickAsset(assets, info.kind);
  const sumsAsset = assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!allowedUrl(asset.url) || !allowedUrl(sumsAsset.url)) throw new Error(t('Refusing to download the update from an unexpected address.'));

  ctx.progress(0.01, t('Reading checksums…'));
  const sumsRes = await fetch(sumsAsset.url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: AbortSignal.timeout(20000) });
  if (!sumsRes.ok) throw new Error(t('Could not download the checksum file.'));
  const expected = parseSums(await sumsRes.text())[asset.name];
  if (!expected) throw new Error(t('The release has no checksum for {file}.', { file: asset.name }));

  const dir = join(dataDir(), 'updates');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(dir)) if (f !== asset.name) rmSync(join(dir, f), { force: true }); // old downloads
  const file = join(dir, asset.name);
  const part = file + '.part';

  const res = await fetch(asset.url, { headers: { 'User-Agent': UA['User-Agent'] } });
  if (!res.ok || !res.body) throw new Error(t('Download failed (HTTP {status}).', { status: res.status }));
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(part, { mode: 0o600 });
  let got = 0;
  const mb = (n) => num(Math.round(n / 1048576));
  try {
    for await (const chunk of res.body) {
      ctx.checkCancel();
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      ctx.progress(total ? 0.02 + (got / total) * 0.93 : 0.5, t('Downloading {got} of {total} MB', { got: mb(got), total: mb(total) }));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
  ctx.progress(0.97, t('Verifying checksum…'));
  const actual = hash.digest('hex');
  if (actual !== expected) {
    rmSync(part, { force: true });
    throw new Error(t('The downloaded file is damaged (checksum mismatch) — it was deleted. Try again.'));
  }
  renameSync(part, file);
  ready = { version: info.latest, kind: info.kind, file };
  if (cache) cache.info.ready = true;
  ctx.log(t('{file} downloaded and verified.', { file: asset.name }));
  return { version: info.latest, kind: info.kind, file: asset.name };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      return resolve(127);
    }
    child.on('error', () => resolve(127));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** Install the verified download. Resolves with what happens next: 'restart' | 'installer' | 'opened'. */
export async function installUpdate() {
  const d = desktop();
  if (!d) throw new Error(t('Updates install only in the desktop app.'));
  if (!ready || !existsSync(ready.file)) throw new Error(t('Download the update first.'));
  const { kind, file } = ready;

  if (kind === 'deb') {
    // apt-get resolves dependencies too; pkexec shows the system's graphical password prompt.
    const code = await run('pkexec', ['apt-get', 'install', '-y', '--allow-downgrades', file]);
    if (code === 0) {
      setTimeout(() => d.relaunch(), 600);
      return { next: 'restart' };
    }
    if (code === 126) throw Object.assign(new Error(t('Installation was cancelled (no password given).')), { code: 'CANCELLED' });
    // No pkexec, or apt failed: let the system's software installer take over.
    await d.openPath(file);
    return { next: 'opened' };
  }
  if (kind === 'appimage') {
    const target = process.env.APPIMAGE;
    const tmp = target + '.new';
    copyFileSync(file, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, target); // atomic on the same filesystem; the running copy keeps its open inode
    setTimeout(() => d.relaunch(target), 600);
    return { next: 'restart' };
  }
  if (kind === 'exe') {
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => d.quit(), 800);
    return { next: 'installer' };
  }
  throw new Error(t('This copy of DBStudio cannot update itself — download the new version from the release page.'));
}

/** For tests: forget the cached release. */
export function resetUpdateCache() {
  cache = null;
  ready = null;
}
