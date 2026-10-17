// Connections: saved list, connect/disconnect, and the connection dialog (with SSH tunnel).
import {
  $, h, icon, esc, api, state, app, emit, local, toast, modal, confirmDialog, connById, segmented, toggle, field, select,
  TYPE_LABEL, DEFAULT_PORT, COLORS, engineBadge,
} from './core.js';
import { closeTab } from './tabs.js';
import { t } from './i18n.js';

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
    if (!silent) toast(`${TYPE_LABEL[conn.type]} ${info.version ? '· ' + String(info.version).split(' ')[0] : ''}`, 'ok', { title: t('Connected to {name}', { name: conn.name }) });
  } catch (e) {
    emit('connect-failed', id);
    toast(e.message, 'err', { title: t('Could not connect to {name}', { name: conn.name }) });
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
    title: t('Delete connection?'),
    message: t('Connection <b>{name}</b> will be removed from the list. The database itself is <b>not</b> affected.', { name: esc(c.name) }),
    danger: true,
    confirmLabel: t('Delete connection'),
  });
  if (!ok) return;
  if (state.active?.conn.id === c.id) await disconnect();
  for (const tab of [...state.tabs]) if (tab.connId === c.id) await closeTab(tab.id, true);
  await api('DELETE', `/api/connections/${c.id}`);
  await loadConns();
}

export async function duplicateConn(c) {
  const { id, hasPassword, ...rest } = c;
  await api('POST', '/api/connections', { ...rest, name: t('{name} (copy)', { name: c.name }), copyPasswordFrom: id });
  await loadConns();
  toast(t('Connection duplicated'), 'ok');
}

export async function openDemo() {
  try {
    const d = await api('GET', '/api/demo');
    if (!d.exists) return toast(t('The demo database has not been created yet. Run: npm run demo'), 'err');
    let c = state.conns.find((x) => x.type === 'sqlite' && x.file === d.file);
    if (!c) {
      c = await api('POST', '/api/connections', { type: 'sqlite', name: t('Demo – Shop'), file: d.file, color: COLORS[2] });
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
    name: inp('name', { placeholder: t('e.g. Production – shop') }),
    group: inp('group', { placeholder: t('No group'), list: 'conn-group-list' }),
    host: inp('host', { placeholder: '127.0.0.1' }),
    port: inp('port', { type: 'number', placeholder: '3306' }),
    user: inp('user'),
    password: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: existing?.hasPassword ? t('•••••• saved — leave empty to keep it') : '' }),
    database: inp('database', { placeholder: t('optional') }),
    file: inp('file', { placeholder: t('/home/you/data/app.db') }),
    sshHost: h('input', { class: 'input', value: ssh.host || '', placeholder: t('server.example.com') }),
    sshPort: h('input', { class: 'input', type: 'number', value: ssh.port || 22 }),
    sshUser: h('input', { class: 'input', value: ssh.user || '', placeholder: 'ubuntu' }),
    sshPassword: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: ssh.hasPassword ? t('•••••• saved') : '' }),
    sshKey: h('input', { class: 'input mono', value: ssh.keyFile || '', placeholder: '~/.ssh/id_ed25519' }),
    sshPass: h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: ssh.hasPassphrase ? t('•••••• saved') : t('leave empty if there is no passphrase') }),
  };
  const ssl = toggle(t('Use SSL/TLS'), Boolean(src.ssl));
  const sshOn = toggle(t('Connect through an SSH tunnel'), Boolean(ssh.enabled), () => syncSsh());

  // engine picker
  const engines = h('div', { class: 'engine-pick' });
  const ENG = [
    ['mysql', 'MySQL / MariaDB', 'Port 3306'],
    ['postgres', 'PostgreSQL', 'Port 5432'],
    ['sqlite', 'SQLite', t('Local file')],
  ];
  for (const [ty, name, sub] of ENG) {
    const b = h('button', { type: 'button', html: `${engineBadge(ty)}<div><div class="ep-name">${name}</div><div class="ep-sub">${sub}</div></div>` });
    b.onclick = () => setType(ty);
    b.dataset.type = ty;
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
    h('div', {}, field(t('Connection name'), f.name)),
    h('div', {}, field(t('Group'), f.group), h('datalist', { id: 'conn-group-list' }, ...[...new Set(state.conns.map((c) => c.group).filter(Boolean))].map((g) => h('option', { value: g })))),
    h('div', { class: 'net' }, field('Host', f.host)),
    h('div', { class: 'net' }, field('Port', f.port)),
    h('div', { class: 'net' }, field('User', f.user)),
    h('div', { class: 'net' }, field('Password', f.password)),
    h('div', { class: 'net full' }, field('Database', f.database, t('Leave empty to see every database on the server.'))),
    h('div', { class: 'net full' }, ssl),
    h('div', { class: 'file full' }, field(t('SQLite file path'), f.file, t('A file that does not exist yet is created automatically — that is how you make a new SQLite database.'))),
    h('div', { class: 'full' }, field(t('Label color'), colors)),
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
    h('div', { class: 'full' }, field(t('Authentication method'), authSeg)),
    h('div', { class: 'full ssh-pw' }, field('SSH password', f.sshPassword)),
    h('div', { class: 'full ssh-key' }, field(t('Private key file'), f.sshKey, t('Path on this computer, e.g. <span class="mono">~/.ssh/id_ed25519</span>'))),
    h('div', { class: 'full ssh-key' }, field(t('Key passphrase'), f.sshPass)),
    h('div', { class: 'full ssh-agent' }, h('div', { class: 'notice info', html: icon('info') + `<div>${t('Uses the keys from the ssh-agent (<span class="mono">SSH_AUTH_SOCK</span>) of the DBStudio process.')}</div>` })),
  );
  const sshPane = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    sshOn,
    h('div', { class: 'notice info', html: icon('route') + `<div>${t('DBStudio opens an SSH connection to the server, then forwards the database connection through the encrypted tunnel. The <b>Host</b> on the General tab is seen from the SSH server — usually <span class="mono">127.0.0.1</span>.')}</div>` }),
    sshFields,
  );

  const panes = h('div', {}, general, sshPane);
  const tabSeg = segmented(
    [
      { value: 'general', label: t('General'), icon: 'plug' },
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
  function setType(ty) {
    type = ty;
    engines.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.type === ty));
    general.querySelectorAll('.net').forEach((e) => (e.hidden = ty === 'sqlite'));
    general.querySelectorAll('.file').forEach((e) => (e.hidden = ty !== 'sqlite'));
    tabRow.hidden = ty === 'sqlite';
    if (ty === 'sqlite') showPane('general');
    f.port.placeholder = DEFAULT_PORT[ty] || '';
    f.user.placeholder = ty === 'postgres' ? 'postgres' : 'root';
    f.database.placeholder = ty === 'postgres' ? 'postgres' : t('all databases');
  }

  function read() {
    const o = { type, name: f.name.value.trim(), color, group: f.group.value.trim() || null };
    if (existing) o.id = existing.id;
    if (type === 'sqlite') {
      o.file = f.file.value.trim();
      if (!o.file) throw new Error(t('Enter the SQLite file path'));
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
      if (o.ssh.enabled && (!o.ssh.host || !o.ssh.user)) throw new Error(t('Enter the SSH host and SSH user'));
    }
    if (!o.name) o.name = type === 'sqlite' ? o.file.split('/').pop() || 'SQLite' : `${o.user}@${o.ssh?.enabled ? o.ssh.host : o.host}`;
    return o;
  }

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } }, engines, tabRow, panes);
  const m = modal({
    title: existing ? t('Edit connection') : t('New connection'),
    sub: existing ? existing.name : t('MySQL/MariaDB, PostgreSQL or SQLite — directly or through SSH'),
    icon: 'plug-zap',
    size: 'wide',
    body,
    actions: [
      existing ? { label: t('Delete'), kind: 'ghost danger', icon: 'trash-2', onClick: async ({ close }) => { close(); await deleteConn(existing); return false; } } : null,
      testResult,
      'spacer',
      {
        label: t('Test'),
        icon: 'activity',
        onClick: async () => {
          testResult.className = 'test-result';
          testResult.innerHTML = `${icon('loader-circle')} ${t('Testing…')}`;
          try {
            const r = await api('POST', '/api/connections/test', read());
            testResult.className = 'test-result ok';
            const version = esc(String(r.version).split(' ').slice(0, 2).join(' '));
            testResult.innerHTML = `${icon('circle-check')} ${r.tunnel ? t('Connected via SSH — {version}', { version }) : t('Connected — {version}', { version })}`;
          } catch (e) {
            testResult.className = 'test-result err';
            testResult.innerHTML = `${icon('circle-x')} ${esc(e.message)}`;
            testResult.title = e.message;
          }
          return false;
        },
      },
      { label: t('Cancel') },
      {
        label: t('Save & connect'),
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
