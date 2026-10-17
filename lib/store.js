// Connection persistence. Stored locally in ~/.dbstudio/connections.json (chmod 600).
// This is a local developer tool; credentials live only on this machine, like
// Beekeeper Studio / SQLYog do. Still, we restrict file permissions.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';

const DIR = join(homedir(), '.dbstudio');
const FILE = join(DIR, 'connections.json');

function ensure() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(FILE)) writeFileSync(FILE, '[]', { mode: 0o600 });
}

export function list() {
  ensure();
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function persist(conns) {
  ensure();
  writeFileSync(FILE, JSON.stringify(conns, null, 2), { mode: 0o600 });
  try {
    chmodSync(FILE, 0o600);
  } catch {
    /* best effort */
  }
}

export function get(id) {
  return list().find((c) => c.id === id);
}

export function save(conn) {
  const conns = list();
  if (conn.id) {
    const i = conns.findIndex((c) => c.id === conn.id);
    if (i >= 0) {
      conns[i] = { ...conns[i], ...conn };
      persist(conns);
      return conns[i];
    }
  }
  const created = { ...conn, id: randomUUID() };
  conns.push(created);
  persist(conns);
  return created;
}

export function remove(id) {
  persist(list().filter((c) => c.id !== id));
}

// Never leak passwords (database or SSH) to the UI.
export function redact(conn) {
  const { password, ssh, ...rest } = conn;
  const out = { ...rest, hasPassword: Boolean(password) };
  if (ssh) {
    const { password: sp, passphrase, ...sshRest } = ssh;
    out.ssh = { ...sshRest, hasPassword: Boolean(sp), hasPassphrase: Boolean(passphrase) };
  }
  return out;
}

// Fill secrets the UI left blank ("keep the stored one") from an existing connection.
export function mergeSecrets(body, existing) {
  if (!existing) return body;
  const out = { ...body };
  if (out.password === undefined) out.password = existing.password;
  if (out.ssh && existing.ssh) {
    out.ssh = { ...out.ssh };
    if (out.ssh.password === undefined) out.ssh.password = existing.ssh.password;
    if (out.ssh.passphrase === undefined) out.ssh.passphrase = existing.ssh.passphrase;
  }
  return out;
}
