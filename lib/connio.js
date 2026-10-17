// Import / export of saved connections.
//
// Formats:
//  - DBStudio:  { format: 'dbstudio-connections', version: 1, connections: [...] }
//               optionally encrypted with a passphrase (scrypt + AES-256-GCM).
//  - Navicat:   .ncx XML export ("Export Connections" in Navicat). Navicat 12+ stores passwords with a
//               fixed, publicly documented AES-128-CBC key; those are decrypted so the import is complete.
//  - DBeaver:   workspace data-sources.json (+ optional credentials-config.json for user/password).
//  - SQLyog:    .sycs export ("Export Connections" in SQLyog) — INI sections [Connection N]; passwords are
//               base64 with every byte rotated one bit, which is reversible, so they are restored too.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { t } from './i18n.js';

const FORMAT = 'dbstudio-connections';
const KEEP = ['name', 'type', 'host', 'port', 'user', 'password', 'database', 'file', 'ssl', 'ssh', 'color', 'group', 'favorite'];

function pick(c) {
  return Object.fromEntries(KEEP.filter((k) => c[k] !== undefined && c[k] !== '').map((k) => [k, c[k]]));
}

function stripSecrets(c) {
  const { password, ...rest } = c;
  if (rest.ssh) {
    const { password: _p, passphrase: _q, ...ssh } = rest.ssh;
    rest.ssh = ssh;
  }
  return rest;
}

// ---------------------------------------------------------------- DBStudio
export function exportConnections(conns, { includePasswords = true, passphrase = '' } = {}) {
  const items = conns.map(pick).map((c) => (includePasswords ? c : stripSecrets(c)));
  const doc = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), count: items.length };
  if (!passphrase) return JSON.stringify({ ...doc, encrypted: false, connections: items }, null, 2);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(items), 'utf8'), cipher.final()]);
  return JSON.stringify(
    {
      ...doc,
      encrypted: true,
      kdf: { name: 'scrypt', N: 1 << 15, r: 8, p: 1, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      data: data.toString('base64'),
    },
    null,
    2,
  );
}

function parseDbstudio(doc, passphrase) {
  let items = doc.connections;
  if (doc.encrypted) {
    if (!passphrase) throw Object.assign(new Error(t('This file is encrypted. Enter the passphrase.')), { code: 'NEED_PASSPHRASE' });
    try {
      const k = doc.kdf;
      const key = scryptSync(passphrase, Buffer.from(k.salt, 'base64'), 32, { N: k.N, r: k.r, p: k.p, maxmem: 64 * 1024 * 1024 });
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(doc.cipher.iv, 'base64'));
      d.setAuthTag(Buffer.from(doc.cipher.tag, 'base64'));
      items = JSON.parse(Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]).toString('utf8'));
    } catch {
      throw Object.assign(new Error(t('Wrong passphrase or damaged file.')), { code: 'BAD_PASSPHRASE' });
    }
  }
  if (!Array.isArray(items)) throw new Error(t('Invalid DBStudio connection file format.'));
  return items.map((c) => ({ conn: pick(c), warnings: [] }));
}

// ---------------------------------------------------------------- Navicat (.ncx)
const NAVICAT_KEY = Buffer.from('libcckeylibcckey');
const NAVICAT_IV = Buffer.from('libcciv libcciv ');

export function navicatDecrypt(hex) {
  if (!hex) return '';
  const d = createDecipheriv('aes-128-cbc', NAVICAT_KEY, NAVICAT_IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
}
export function navicatEncrypt(text) {
  const c = createCipheriv('aes-128-cbc', NAVICAT_KEY, NAVICAT_IV);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex').toUpperCase();
}

const xmlUnescape = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });

function parseNavicat(xml) {
  const ver = /<Connections[^>]*\bVer="([^"]*)"/i.exec(xml)?.[1] || '';
  const legacy = ver && parseFloat(ver) < 1.2;
  const out = [];
  for (const m of xml.matchAll(/<Connection\s([^>]*?)\/?>/gis)) {
    const a = {};
    for (const at of m[1].matchAll(/([\w:.-]+)="([^"]*)"/g)) a[at[1]] = xmlUnescape(at[2]);
    const warnings = [];
    const ct = String(a.ConnType || '').toUpperCase();
    const type = { MYSQL: 'mysql', MARIADB: 'mysql', POSTGRESQL: 'postgres', SQLITE: 'sqlite' }[ct];
    if (!type) {
      out.push({ conn: { name: a.ConnectionName || t('(unnamed)'), type: null }, warnings: [t('Type {type} is not supported by DBStudio yet — skipped.', { type: ct || '?' })], skip: true });
      continue;
    }
    const dec = (v, what) => {
      if (!v) return undefined;
      if (legacy) {
        warnings.push(t('{what} from an old Navicat version (before 12) cannot be decrypted — enter it manually after the import.', { what }));
        return undefined;
      }
      try {
        return navicatDecrypt(v);
      } catch {
        warnings.push(t('{what} could not be decrypted — enter it manually after the import.', { what }));
        return undefined;
      }
    };
    const conn = { name: a.ConnectionName || `${type} ${a.Host || ''}`.trim(), type };
    if (type === 'sqlite') {
      conn.file = a.DatabaseFileName || a.DatabaseFile || '';
      if (!conn.file) warnings.push(t('The Navicat file has no SQLite file path.'));
    } else {
      conn.host = a.Host || '127.0.0.1';
      conn.port = Number(a.Port) || (type === 'mysql' ? 3306 : 5432);
      conn.user = a.UserName || '';
      conn.password = dec(a.Password, t('Database password'));
      conn.database = a.Database || a.InitialDatabase || '';
      if (/^true$/i.test(a.SSL || '')) conn.ssl = true;
      if (/^true$/i.test(a.SSH || '')) {
        const key = /PUBLICKEY/i.test(a.SSH_AuthenMethod || '');
        conn.ssh = {
          enabled: true,
          host: a.SSH_Host || '',
          port: Number(a.SSH_Port) || 22,
          user: a.SSH_UserName || '',
          auth: key ? 'key' : 'password',
          keyFile: key ? a.SSH_PrivateKey || '' : undefined,
          password: key ? undefined : dec(a.SSH_Password, t('SSH password')),
          passphrase: key ? dec(a.SSH_Passphrase, t('SSH passphrase')) : undefined,
        };
      }
      if (a.SavePassword && /^false$/i.test(a.SavePassword)) warnings.push(t('Navicat did not save the password of this connection.'));
      if (/^true$/i.test(a.HTTP || '')) warnings.push(t('Navicat HTTP tunnels are not supported — the connection is created without the HTTP tunnel.'));
    }
    out.push({ conn, warnings });
  }
  if (!out.length) throw new Error(t('No connections in this Navicat file.'));
  return out;
}

// ---------------------------------------------------------------- DBeaver
const DBEAVER_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');

export function dbeaverDecryptCredentials(buf) {
  const iv = buf.subarray(0, 16);
  const d = createDecipheriv('aes-128-cbc', DBEAVER_KEY, iv);
  return JSON.parse(Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8'));
}

function parseDbeaver(doc, credentialsB64) {
  let creds = {};
  if (credentialsB64) {
    try {
      creds = dbeaverDecryptCredentials(Buffer.from(credentialsB64, 'base64'));
    } catch {
      throw new Error(t('The DBeaver credentials-config.json could not be decrypted.'));
    }
  }
  const out = [];
  for (const [id, c] of Object.entries(doc.connections || {})) {
    const cfg = c.configuration || {};
    const provider = String(c.provider || c.driver || '').toLowerCase();
    const type = /maria|mysql/.test(provider) ? 'mysql' : /postgre/.test(provider) ? 'postgres' : /sqlite/.test(provider) ? 'sqlite' : null;
    const warnings = [];
    if (!type) {
      out.push({ conn: { name: c.name || id, type: null }, warnings: [t('Driver {driver} is not supported by DBStudio yet — skipped.', { driver: provider || '?' })], skip: true });
      continue;
    }
    const cr = creds[id]?.['#connection'] || {};
    const conn = { name: c.name || id, type };
    if (c.folder) conn.group = String(c.folder).split('/').pop();
    if (type === 'sqlite') conn.file = cfg.database || (cfg.url || '').replace(/^jdbc:sqlite:/, '');
    else {
      conn.host = cfg.host || '127.0.0.1';
      conn.port = Number(cfg.port) || (type === 'mysql' ? 3306 : 5432);
      conn.database = cfg.database || '';
      conn.user = cr.user || cfg.user || '';
      conn.password = cr.password || undefined;
      if (!credentialsB64) warnings.push(t('Passwords are stored in credentials-config.json — include that file to import them too.'));
      const ssh = cfg.handlers?.ssh_tunnel;
      if (ssh?.enabled) {
        const p = ssh.properties || {};
        const sc = creds[id]?.['network/ssh_tunnel'] || {};
        conn.ssh = {
          enabled: true,
          host: p.host || '',
          port: Number(p.port) || 22,
          user: sc.user || p.user || '',
          auth: /public/i.test(p.authType || '') ? 'key' : 'password',
          keyFile: p.keyPath || undefined,
          password: sc.password || undefined,
        };
      }
    }
    out.push({ conn, warnings });
  }
  if (!out.length) throw new Error(t('No connections in this DBeaver file.'));
  return out;
}

// ---------------------------------------------------------------- SQLyog (.sycs)
/** SQLyog stores saved passwords as base64 of the bytes rotated right by one bit (decoding rotates them back left). */
export function sqlyogEncode(text) {
  const raw = Buffer.from(String(text), 'utf8');
  return Buffer.from(raw.map((x) => ((x >> 1) | (x << 7)) & 0xff)).toString('base64');
}
export const sqlyogDecode = (v) => rotl(v);

const isSqlyog = (text) => /^\s*\[Connection[^\]]*\]\s*$/m.test(text) && /^\s*Host=/m.test(text);

function parseIni(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) {
      cur = { _section: sec[1], _keys: {} };
      out.push(cur);
      continue;
    }
    const i = line.indexOf('=');
    if (cur && i > 0) cur._keys[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function parseSqlyog(text) {
  const out = [];
  for (const sec of parseIni(text)) {
    const a = sec._keys;
    if (!/^connection/i.test(sec._section) || !('host' in a || 'name' in a)) continue;
    const warnings = [];
    const on = (k) => a[k] === '1';
    const dec = (v, what) => {
      if (!v) return undefined;
      const plain = rotl(v);
      // A value that does not decode to readable text was stored in a way we don't know — don't import garbage.
      if (plain == null) {
        warnings.push(t('{what} could not be decrypted — enter it manually after the import.', { what }));
        return undefined;
      }
      return plain;
    };
    const conn = {
      name: a.name || `MySQL ${a.host || ''}`.trim(),
      type: 'mysql',
      host: a.host || '127.0.0.1',
      port: Number(a.port) || 3306,
      user: a.user || '',
    };
    if (on('storepassword')) conn.password = dec(a.password, t('Database password'));
    else if (a.password) warnings.push(t('SQLyog did not save the password of this connection.'));
    // SQLyog keeps a ";"-separated list of databases to show; the first one becomes the default.
    const dbs = String(a.database || '').split(';').map((x) => x.trim()).filter(Boolean);
    if (dbs.length) conn.database = dbs[0];
    if (dbs.length > 1) warnings.push(t('SQLyog listed several databases ({list}); {first} is used as the default.', { list: dbs.join(', '), first: dbs[0] }));
    if (on('sslchecked')) {
      conn.ssl = true;
      if (a.ca || a.client_key || a.client_cert) warnings.push(t('SSL certificate files are not imported; the connection uses SSL without them.'));
    }
    if (on('ssh')) {
      const key = on('sshprivateradio');
      conn.ssh = {
        enabled: true,
        host: a.sshhost || '',
        port: Number(a.sshport) || 22,
        user: a.sshuser || '',
        auth: key ? 'key' : 'password',
        keyFile: key ? a.sshprivatekeypath || '' : undefined,
        password: key ? undefined : on('sshsavepassword') || a.sshpwd ? dec(a.sshpwd, t('SSH password')) : undefined,
      };
      if (key && /^[a-z]:\\/i.test(a.sshprivatekeypath || '')) warnings.push(t('The SSH key path is a Windows path ({path}) — point it to the key on this computer.', { path: a.sshprivatekeypath }));
    }
    if (on('tunnel')) warnings.push(t('SQLyog HTTP tunnels are not supported — the connection is created without the HTTP tunnel.'));
    // Object browser background (Windows COLORREF 0x00BBGGRR); white is SQLyog's default and means "no color".
    const bg = Number(a.objectbrowserbkcolor);
    if (Number.isFinite(bg) && bg !== 16777215 && bg >= 0 && bg <= 0xffffff) {
      const hex = (n) => n.toString(16).padStart(2, '0');
      conn.color = `#${hex(bg & 0xff)}${hex((bg >> 8) & 0xff)}${hex((bg >> 16) & 0xff)}`;
    }
    out.push({ conn, warnings });
  }
  if (!out.length) throw new Error(t('No connections in this SQLyog file.'));
  return out;
}

// base64 → rotate each byte left by one bit; null when the result is not readable text.
function rotl(v) {
  let raw;
  try {
    raw = Buffer.from(String(v), 'base64');
  } catch {
    return null;
  }
  const out = Buffer.from(raw.map((x) => ((x << 1) | (x >> 7)) & 0xff));
  const s = out.toString('utf8');
  return !out.length || s.includes('�') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s) ? null : s;
}

// ---------------------------------------------------------------- dispatcher + preview sessions
export function parseImport({ content, filename = '', passphrase = '', credentials = '' }) {
  let text = String(content || '').replace(/^[\uFEFF\uFFFD]+/, '').trim();
  // Windows tools sometimes write UTF-16; read as UTF-8 that leaves a NUL after every ASCII character.
  if (/^(?:[^\0]\0){8}/.test(text)) text = text.replace(/\0/g, '').trim();
  if (!text) throw new Error(t('The file is empty'));
  if (text.startsWith('<')) return { source: 'Navicat', items: parseNavicat(text) };
  if (isSqlyog(text)) return { source: 'SQLyog', items: parseSqlyog(text) };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(t('Unrecognized format of file "{file}" (supported: DBStudio .json, Navicat .ncx, SQLyog .sycs, DBeaver data-sources.json).', { file: filename }));
  }
  if (doc.format === FORMAT) return { source: 'DBStudio', items: parseDbstudio(doc, passphrase) };
  if (doc.connections && !Array.isArray(doc.connections)) return { source: 'DBeaver', items: parseDbeaver(doc, credentials) };
  if (Array.isArray(doc)) return { source: 'DBStudio', items: doc.map((c) => ({ conn: pick(c), warnings: [] })) };
  throw new Error(t('Unrecognized file format.'));
}

const sessions = new Map();
export function startImport(input) {
  for (const [k, v] of sessions) if (Date.now() - v.at > 15 * 60 * 1000) sessions.delete(k);
  const parsed = parseImport(input);
  const id = randomUUID();
  sessions.set(id, { at: Date.now(), ...parsed });
  return { id, ...parsed };
}
export function takeImport(id) {
  const s = sessions.get(id);
  if (!s) throw new Error(t('The import session has expired — choose the file again.'));
  sessions.delete(id);
  return s;
}

export function previewItem({ conn, warnings, skip }) {
  const s = stripSecrets(conn);
  return {
    ...s,
    hasPassword: Boolean(conn.password),
    ssh: conn.ssh ? { ...s.ssh, hasPassword: Boolean(conn.ssh.password), hasPassphrase: Boolean(conn.ssh.passphrase) } : undefined,
    warnings,
    skip: Boolean(skip),
  };
}

// Same server + user + database (or same SQLite file) counts as a duplicate.
export function sameTarget(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'sqlite') return a.file === b.file;
  return (
    String(a.host || '127.0.0.1') === String(b.host || '127.0.0.1') &&
    Number(a.port || 0) === Number(b.port || 0) &&
    String(a.user || '') === String(b.user || '') &&
    String(a.database || '') === String(b.database || '') &&
    Boolean(a.ssh?.enabled) === Boolean(b.ssh?.enabled) &&
    String(a.ssh?.host || '') === String(b.ssh?.host || '')
  );
}
