// Connections: saved list, connect/disconnect, and the connection dialog (with SSH tunnel).
import {
  $, h, icon, esc, api, state, app, emit, local, toast, modal, confirmDialog, connById, segmented, toggle, field, select,
  TYPE_LABEL, DEFAULT_PORT, COLORS, engineBadge,
} from './core.js';
import { closeTab } from './tabs.js';

export async function loadConns() {
  state.conns = await api('GET', '/api/connections');
  emit('conns');
}

export function connSub(c) {
  if (c.type === 'sqlite') return String(c.file || '').split('/').pop();
  return `${c.user ? c.user + '@' : ''}${c.host || '127.0.0.1'}:${c.port || DEFAULT_PORT[c.type]}`;
}

export async function connect(id, { silent = false } = {}) {
  const conn = connById(id);
  if (!conn) return;
  if (state.active?.conn.id === id) {
    app.showPanel('explorer');
    return;
  }
  emit('connecting', id);
  try {
    const info = await api('POST', `/api/c/${id}/connect`);
    state.active = { conn, ...info, ns: info.namespaces.includes(info.defaultNs) ? info.defaultNs : info.namespaces[0] };
    state.tables = [];
    state.columns = {};
    local.set('dbs-last-conn', id);
    emit('connected', id);
    app.showPanel('explorer');
    await app.loadTree();
    if (!state.tabs.length) app.newQueryTab();
    if (!silent) toast(`${TYPE_LABEL[conn.type]} ${info.version ? '· ' + String(info.version).split(' ')[0] : ''}`, 'ok', { title: `Terhubung ke ${conn.name}` });
  } catch (e) {
    emit('connect-failed', id);
    toast(e.message, 'err', { title: `Gagal terhubung ke ${conn.name}` });
  }
}

export async function disconnect() {
  if (!state.active) return;
  const id = state.active.conn.id;
  state.active = null;
  state.tables = [];
  state.columns = {};
  state.objects = { routines: [], triggers: [], events: [] };
  local.set('dbs-last-conn', null);
  emit('connected', null);
  api('POST', `/api/c/${id}/disconnect`).catch(() => {});
}

export async function deleteConn(c) {
  const ok = await confirmDialog({
    title: 'Hapus koneksi?',
    message: `Koneksi <b>${esc(c.name)}</b> akan dihapus dari daftar. Database-nya sendiri <b>tidak</b> terpengaruh.`,
    danger: true,
    confirmLabel: 'Hapus koneksi',
  });
  if (!ok) return;
  if (state.active?.conn.id === c.id) await disconnect();
  for (const t of [...state.tabs]) if (t.connId === c.id) await closeTab(t.id, true);
  await api('DELETE', `/api/connections/${c.id}`);
  await loadConns();
}

export async function duplicateConn(c) {
  const { id, hasPassword, ...rest } = c;
  await api('POST', '/api/connections', { ...rest, name: c.name + ' (salinan)', copyPasswordFrom: id });
  await loadConns();
  toast('Koneksi diduplikat', 'ok');
}

export async function openDemo() {
  try {
    const d = await api('GET', '/api/demo');
    if (!d.exists) return toast('Database demo belum dibuat. Jalankan: npm run demo', 'err');
    let c = state.conns.find((x) => x.type === 'sqlite' && x.file === d.file);
    if (!c) {
      c = await api('POST', '/api/connections', { type: 'sqlite', name: 'Demo – Toko', file: d.file, color: COLORS[2] });
      await loadConns();
    }
    await connect(c.id);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------------------------------------------------------------- dialog
export function openConnDialog(existing = null, preset = {}) {
  const src = structuredClone(existing || preset);
  let type = src.type || 'mysql';
  let color = src.color || COLORS[0];
  const ssh = { enabled: false, port: 22, auth: 'password', ...(src.ssh || {}) };

  const inp = (name, attrs = {}) => h('input', { class: 'input', name, value: src[name] ?? '', autocomplete: 'off', ...attrs });
  const f = {
    name: inp('name', { placeholder: 'mis. Produksi – toko' }),
    host: inp('host', { placeholder: '127.0.0.1' }),
    port: inp('port', { type: 'number', placeholder: '3306' }),
    user: inp('user'),
    password: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: existing?.hasPassword ? '•••••• tersimpan — kosongkan untuk tetap' : '' }),
    database: inp('database', { placeholder: 'opsional' }),
    file: inp('file', { placeholder: '/home/kamu/data/app.db' }),
    sshHost: h('input', { class: 'input', value: ssh.host || '', placeholder: 'server.contoh.com' }),
    sshPort: h('input', { class: 'input', type: 'number', value: ssh.port || 22 }),
    sshUser: h('input', { class: 'input', value: ssh.user || '', placeholder: 'ubuntu' }),
    sshPassword: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: ssh.hasPassword ? '•••••• tersimpan' : '' }),
    sshKey: h('input', { class: 'input mono', value: ssh.keyFile || '', placeholder: '~/.ssh/id_ed25519' }),
    sshPass: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: ssh.hasPassphrase ? '•••••• tersimpan' : 'kosongkan jika tanpa passphrase' }),
  };
  const ssl = toggle('Gunakan SSL/TLS', Boolean(src.ssl));
  const sshOn = toggle('Hubungkan lewat SSH tunnel', Boolean(ssh.enabled), () => syncSsh());

  // engine picker
  const engines = h('div', { class: 'engine-pick' });
  const ENG = [
    ['mysql', 'MySQL / MariaDB', 'Port 3306'],
    ['postgres', 'PostgreSQL', 'Port 5432'],
    ['sqlite', 'SQLite', 'File lokal'],
  ];
  for (const [t, name, sub] of ENG) {
    const b = h('button', { type: 'button', html: `${engineBadge(t)}<div><div class="ep-name">${name}</div><div class="ep-sub">${sub}</div></div>` });
    b.onclick = () => setType(t);
    b.dataset.type = t;
    engines.append(b);
  }

  // colors
  const colors = h('div', { class: 'colors' });
  const renderColors = () => {
    colors.innerHTML = '';
    for (const c of COLORS) {
      const b = h('button', { type: 'button', class: c === color ? 'active' : '', style: { background: c } });
      b.onclick = () => {
        color = c;
        renderColors();
      };
      colors.append(b);
    }
  };
  renderColors();

  const general = h(
    'div',
    { class: 'form-grid' },
    h('div', { class: 'full' }, field('Nama koneksi', f.name)),
    h('div', { class: 'net' }, field('Host', f.host)),
    h('div', { class: 'net' }, field('Port', f.port)),
    h('div', { class: 'net' }, field('User', f.user)),
    h('div', { class: 'net' }, field('Password', f.password)),
    h('div', { class: 'net full' }, field('Database', f.database, 'Kosongkan untuk melihat semua database di server.')),
    h('div', { class: 'net full' }, ssl),
    h('div', { class: 'file full' }, field('Path file SQLite', f.file, 'File yang belum ada akan dibuat otomatis — cara membuat database SQLite baru.')),
    h('div', { class: 'full' }, field('Warna penanda', colors)),
  );

  const authSeg = segmented(
    [
      { value: 'password', label: 'Password', icon: 'key-round' },
      { value: 'key', label: 'Private key', icon: 'file-key' },
      { value: 'agent', label: 'SSH agent', icon: 'fingerprint' },
    ],
    ssh.auth,
    () => syncSsh(),
  );
  const sshFields = h(
    'div',
    { class: 'form-grid' },
    h('div', {}, field('SSH host', f.sshHost)),
    h('div', {}, field('SSH port', f.sshPort)),
    h('div', { class: 'full' }, field('SSH user', f.sshUser)),
    h('div', { class: 'full' }, field('Metode autentikasi', authSeg)),
    h('div', { class: 'full ssh-pw' }, field('SSH password', f.sshPassword)),
    h('div', { class: 'full ssh-key' }, field('File private key', f.sshKey, 'Path di komputer ini, mis. <span class="mono">~/.ssh/id_ed25519</span>')),
    h('div', { class: 'full ssh-key' }, field('Passphrase key', f.sshPass)),
    h('div', { class: 'full ssh-agent' }, h('div', { class: 'notice info', html: icon('info') + '<div>Memakai kunci dari ssh-agent (<span class="mono">SSH_AUTH_SOCK</span>) milik proses DBStudio.</div>' })),
  );
  const sshPane = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    sshOn,
    h('div', { class: 'notice info', html: icon('route') + '<div>DBStudio membuka koneksi SSH ke server, lalu meneruskan koneksi database lewat terowongan terenkripsi. <b>Host</b> di tab Umum dilihat dari sisi server SSH — biasanya <span class="mono">127.0.0.1</span>.</div>' }),
    sshFields,
  );

  const panes = h('div', {}, general, sshPane);
  const tabSeg = segmented(
    [
      { value: 'general', label: 'Umum', icon: 'plug' },
      { value: 'ssh', label: 'SSH Tunnel', icon: 'shield-check' },
    ],
    'general',
    (v) => showPane(v),
  );
  const tabRow = h('div', { class: 'row' }, tabSeg);
  const testResult = h('span', { class: 'test-result' });

  function showPane(v) {
    general.hidden = v !== 'general';
    sshPane.hidden = v !== 'ssh';
    (v === 'general' ? general : sshPane).animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  function syncSsh() {
    const on = sshOn.input.checked;
    sshFields.style.opacity = on ? 1 : 0.45;
    sshFields.style.pointerEvents = on ? '' : 'none';
    const a = authSeg.value;
    sshFields.querySelectorAll('.ssh-pw').forEach((e) => (e.hidden = a !== 'password'));
    sshFields.querySelectorAll('.ssh-key').forEach((e) => (e.hidden = a !== 'key'));
    sshFields.querySelectorAll('.ssh-agent').forEach((e) => (e.hidden = a !== 'agent'));
  }
  function setType(t) {
    type = t;
    engines.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.type === t));
    general.querySelectorAll('.net').forEach((e) => (e.hidden = t === 'sqlite'));
    general.querySelectorAll('.file').forEach((e) => (e.hidden = t !== 'sqlite'));
    tabRow.hidden = t === 'sqlite';
    if (t === 'sqlite') showPane('general');
    f.port.placeholder = DEFAULT_PORT[t] || '';
    f.user.placeholder = t === 'postgres' ? 'postgres' : 'root';
    f.database.placeholder = t === 'postgres' ? 'postgres' : 'semua database';
  }

  function read() {
    const o = { type, name: f.name.value.trim(), color };
    if (existing) o.id = existing.id;
    if (type === 'sqlite') {
      o.file = f.file.value.trim();
      if (!o.file) throw new Error('Isi path file SQLite');
    } else {
      o.host = f.host.value.trim() || '127.0.0.1';
      o.port = f.port.value ? Number(f.port.value) : DEFAULT_PORT[type];
      o.user = f.user.value.trim() || (type === 'postgres' ? 'postgres' : 'root');
      o.database = f.database.value.trim();
      o.ssl = ssl.input.checked;
      if (f.password.value !== '' || !existing?.hasPassword) o.password = f.password.value;
      o.ssh = {
        enabled: sshOn.input.checked,
        host: f.sshHost.value.trim(),
        port: Number(f.sshPort.value) || 22,
        user: f.sshUser.value.trim(),
        auth: authSeg.value,
        keyFile: f.sshKey.value.trim(),
      };
      if (f.sshPassword.value !== '' || !ssh.hasPassword) o.ssh.password = f.sshPassword.value;
      if (f.sshPass.value !== '' || !ssh.hasPassphrase) o.ssh.passphrase = f.sshPass.value;
      if (o.ssh.enabled && (!o.ssh.host || !o.ssh.user)) throw new Error('Isi SSH host dan SSH user');
    }
    if (!o.name) o.name = type === 'sqlite' ? o.file.split('/').pop() || 'SQLite' : `${o.user}@${o.ssh?.enabled ? o.ssh.host : o.host}`;
    return o;
  }

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } }, engines, tabRow, panes);
  const m = modal({
    title: existing ? `Edit koneksi` : 'Koneksi baru',
    sub: existing ? existing.name : 'MySQL/MariaDB, PostgreSQL, atau SQLite — langsung atau lewat SSH',
    icon: 'plug-zap',
    size: 'wide',
    body,
    actions: [
      existing ? { label: 'Hapus', kind: 'ghost danger', icon: 'trash-2', onClick: async ({ close }) => { close(); await deleteConn(existing); return false; } } : null,
      testResult,
      'spacer',
      {
        label: 'Tes',
        icon: 'activity',
        onClick: async () => {
          testResult.className = 'test-result';
          testResult.innerHTML = `${icon('loader-circle')} Menguji…`;
          try {
            const r = await api('POST', '/api/connections/test', read());
            testResult.className = 'test-result ok';
            testResult.innerHTML = `${icon('circle-check')} Berhasil${r.tunnel ? ' via SSH' : ''} — ${esc(String(r.version).split(' ').slice(0, 2).join(' '))}`;
          } catch (e) {
            testResult.className = 'test-result err';
            testResult.innerHTML = `${icon('circle-x')} ${esc(e.message)}`;
            testResult.title = e.message;
          }
          return false;
        },
      },
      { label: 'Batal' },
      {
        label: 'Simpan & hubungkan',
        kind: 'primary',
        icon: 'zap',
        onClick: async () => {
          const o = read();
          const wasActive = state.active?.conn.id === o.id;
          const saved = await api('POST', '/api/connections', o);
          if (wasActive) await disconnect();
          await loadConns();
          setTimeout(() => connect(saved.id), 50);
          return true;
        },
      },
    ].filter(Boolean),
  });
  m.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      m.foot.querySelector('.btn.primary')?.click();
    }
  });
  setType(type);
  showPane('general');
  syncSsh();
  return m;
}

// Lazily-loaded namespace + table lists for any connection (copy wizard, compare, etc.).
const nsCache = new Map();
export async function namespacesOf(connId) {
  if (!nsCache.has(connId)) nsCache.set(connId, api('GET', `/api/c/${connId}/namespaces`).catch((e) => (nsCache.delete(connId), Promise.reject(e))));
  return nsCache.get(connId);
}
export const forgetNamespaces = (connId) => nsCache.delete(connId);

export function connSelect(value, onchange) {
  const el = select(state.conns.map((c) => ({ value: c.id, label: `${c.name} — ${TYPE_LABEL[c.type]}` })), value);
  el.addEventListener('change', () => onchange?.(el.value));
  return el;
}

export function defaultNsFor(conn, namespaces) {
  if (conn.type === 'postgres') return namespaces.includes('public') ? 'public' : namespaces[0];
  if (conn.type === 'sqlite') return 'main';
  return conn.database && namespaces.includes(conn.database) ? conn.database : namespaces.find((n) => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(n)) || namespaces[0];
}

Object.assign(app, { connect, disconnect, openConnDialog, openDemo, loadConns, deleteConn, duplicateConn });
void $;
