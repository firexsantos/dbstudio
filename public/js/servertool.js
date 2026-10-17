// Server tools: process list (kill), variables, status, users & privileges.
import { h, icon, esc, api, qs, state, app, toast, modal, sqlPreview, confirmDialog, toggle, checkbox, field, select, TYPE_LABEL, showMenu } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { renderGrid } from './grid.js';
import { t, plural } from './i18n.js';

const MYSQL_PRIVS = ['ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER', 'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'LOCK TABLES', 'CREATE TEMPORARY TABLES'];
const PG_PRIVS = ['ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

export function openServer() {
  const a = state.active;
  if (!a) return;
  const prev = findTab((t) => t.kind === 'server' && t.connId === a.conn.id);
  if (prev) return activateTab(prev.id);
  const type = a.conn.type;
  const sqlite = type === 'sqlite';
  const panel = h('div');
  const subtabs = h('div', { class: 'subtabs' });
  const SUBS = [
    ['proc', t('Processes'), 'activity', !sqlite],
    ['vars', sqlite ? 'Pragma' : t('Variables'), 'sliders-horizontal', true],
    ['status', t('Status'), 'gauge', true],
    ['users', t('Users'), 'users', !sqlite],
  ].filter((x) => x[3]);
  const panes = {};
  for (const [k, label, ico] of SUBS) subtabs.append(h('button', { class: 'subtab', 'data-sub': k, html: icon(ico) + label }));
  subtabs.append(h('span', { class: 'spacer' }), h('span', { class: 'chip', html: `${icon('server')} ${esc(a.conn.name)} · ${TYPE_LABEL[type]} ${esc(String(a.version || '').split(' ')[0])}` }));
  panel.append(subtabs);

  // ---- processes
  if (!sqlite) {
    const gw = h('div', { class: 'grid-wrap' });
    const auto = toggle(t('Auto-refresh (3 s)'), false, (v) => {
      clearInterval(tab.timer);
      if (v) tab.timer = setInterval(() => !panes.proc.hidden && !panel.hidden && loadProc(), 3000);
    });
    const count = h('span', { class: 'chip' });
    const loadProc = async () => {
      try {
        const r = await api('GET', `/api/c/${a.conn.id}/server/processes`);
        count.textContent = plural(r.rows.length, '{n} connection', '{n} connections');
        renderGrid(gw, {
          columns: r.columns,
          rows: r.rows,
          onCellMenu: (e, row) =>
            showMenu(e, [
              { label: t('Process #{id}', { id: r.rows[row][0] }), header: true },
              { label: t('Stop query (KILL QUERY)'), icon: 'square', action: () => kill(r.rows[row][0], 'query') },
              { label: t('Disconnect (KILL)'), icon: 'unplug', danger: true, action: () => kill(r.rows[row][0], 'connection') },
            ]),
        });
      } catch (e) {
        gw.innerHTML = '';
        gw.append(h('div', { class: 'result-error', text: e.message }));
      }
    };
    const kill = async (pid, mode) => {
      const ok = await confirmDialog({ title: mode === 'query' ? t('Stop query?') : t('Disconnect?'), message: mode === 'query' ? t('The query of process <b>#{pid}</b> will be stopped.', { pid: esc(pid) }) : t('Process <b>#{pid}</b> will be disconnected.', { pid: esc(pid) }), danger: true, confirmLabel: t('Yes') });
      if (!ok) return;
      try {
        await api('POST', `/api/c/${a.conn.id}/server/kill`, { pid, mode });
        toast(t('Process #{pid} stopped', { pid }), 'ok');
        loadProc();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    panes.proc = h('div', { class: 'subpanel' }, h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', html: icon('refresh-cw') + `<span>${t('Refresh')}</span>`, onclick: loadProc }), auto, count, h('span', { class: 'spacer' }), h('span', { class: 'info', text: t('Right-click a row to stop a process') })), gw);
    panes.proc.load = loadProc;
  }

  // ---- variables / status (filterable key-value grids)
  const kvPane = (url, placeholder) => {
    const gw = h('div', { class: 'grid-wrap' });
    const filter = h('input', { class: 'input sm', placeholder, style: { width: '260px' } });
    let data = null;
    const render = () => {
      const q = filter.value.toLowerCase();
      renderGrid(gw, { columns: data.columns, rows: data.rows.filter((r) => !q || r.some((v) => String(v ?? '').toLowerCase().includes(q))) });
    };
    filter.oninput = () => data && render();
    const pane = h('div', { class: 'subpanel' }, h('div', { class: 'toolbar' }, h('div', { class: 'search', html: icon('search') }, filter), h('button', { class: 'btn sm', html: icon('refresh-cw'), onclick: () => load() })), gw);
    const load = async () => {
      try {
        data = await api('GET', url);
        render();
      } catch (e) {
        gw.innerHTML = '';
        gw.append(h('div', { class: 'result-error', text: e.message }));
      }
    };
    pane.load = () => !data && load();
    return pane;
  };
  panes.vars = kvPane(`/api/c/${a.conn.id}/server/variables`, t('Search variables…'));
  panes.status = kvPane(`/api/c/${a.conn.id}/server/status`, t('Search status…'));

  // ---- users
  if (!sqlite) {
    const gw = h('div', { class: 'grid-wrap' });
    const grants = h('div', { class: 'log', style: { maxHeight: 'none', flex: 1 } });
    let users = null;
    let sel = null;
    const showGrants = async (u) => {
      sel = u;
      grants.innerHTML = `<div class="faint">${t('Loading privileges for {user}…', { user: esc(u.user) })}</div>`;
      try {
        const r = await api('GET', `/api/c/${a.conn.id}/server/grants${qs({ user: u.user, host: u.host })}`);
        grants.innerHTML = r.grants.length ? r.grants.map((g) => `<div>${esc(g)}</div>`).join('') : `<div class="faint">${t('No explicit privileges.')}</div>`;
      } catch (e) {
        grants.innerHTML = `<div class="error">${esc(e.message)}</div>`;
      }
    };
    const loadUsers = async () => {
      try {
        users = await api('GET', `/api/c/${a.conn.id}/server/users`);
        renderGrid(gw, {
          columns: users.columns,
          rows: users.rows,
          onRowNumClick: (r) => showGrants(rowUser(r)),
          onCellMenu: (e, r) => {
            const u = rowUser(r);
            showGrants(u);
            showMenu(e, [
              { label: u.host ? `${u.user}@${u.host}` : u.user, header: true },
              { label: t('Grant privileges (GRANT)…'), icon: 'shield-plus', action: () => grantDialog(u, 'grant') },
              { label: t('Revoke privileges (REVOKE)…'), icon: 'shield-minus', action: () => grantDialog(u, 'revoke') },
              { label: t('Change password…'), icon: 'key-round', action: () => passwordDialog(u) },
              '-',
              { label: t('Delete user…'), icon: 'user-x', danger: true, action: () => run('drop', u) },
            ]);
          },
        });
      } catch (e) {
        gw.innerHTML = '';
        gw.append(h('div', { class: 'result-error', text: e.message }));
      }
    };
    const rowUser = (r) => ({ user: users.rows[r][0], host: type === 'mysql' ? users.rows[r][1] : undefined });
    const run = async (action, payload) => {
      const { statements } = await api('POST', `/api/c/${a.conn.id}/sql/user`, { action, ...payload });
      const ok = await sqlPreview({ title: { create: t('Create user'), drop: t('Delete user'), grant: t('Grant privileges'), revoke: t('Revoke privileges'), password: t('Change password') }[action], statements, connId: a.conn.id, type, danger: action === 'drop', confirmLabel: t('Run') });
      if (ok) {
        toast(t('Done'), 'ok');
        loadUsers();
        if (sel) showGrants(sel);
      }
    };
    const createDialog = () => {
      const user = h('input', { class: 'input mono', placeholder: t('user_name') });
      const host = h('input', { class: 'input mono', value: '%', placeholder: t('% or localhost') });
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
      modal({
        title: t('New user'),
        icon: 'user-plus',
        body: h('div', { class: 'form-grid' }, field(t('User name'), user), type === 'mysql' ? field('Host', host, t('<span class="mono">%</span> = from anywhere')) : h('span'), h('div', { class: 'full' }, field(t('Password'), pw))),
        actions: ['spacer', { label: t('Cancel') }, { label: t('Continue'), kind: 'primary', onClick: () => (setTimeout(() => run('create', { user: user.value.trim(), host: host.value.trim(), password: pw.value }).catch((e) => toast(e.message, 'err'))), true) }],
      });
    };
    const passwordDialog = (u) => {
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
      modal({ title: t('Password for {user}', { user: u.user }), icon: 'key-round', body: field(t('New password'), pw), actions: ['spacer', { label: t('Cancel') }, { label: t('Continue'), kind: 'primary', onClick: () => (setTimeout(() => run('password', { ...u, password: pw.value }).catch((e) => toast(e.message, 'err'))), true) }] });
    };
    const grantDialog = (u, action) => {
      const privs = new Set(['SELECT']);
      const box = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' } });
      for (const p of type === 'mysql' ? MYSQL_PRIVS : PG_PRIVS) box.append(checkbox(p, privs.has(p), (v) => (v ? privs.add(p) : privs.delete(p))));
      const nsSel = select(type === 'mysql' ? [{ value: '*', label: t('*  (all databases)') }, ...state.active.namespaces.map((n) => ({ value: n, label: n }))] : state.active.namespaces.map((n) => ({ value: n, label: n })), state.active.ns);
      modal({
        title: action === 'grant' ? t('GRANT to {user}', { user: u.user }) : t('REVOKE from {user}', { user: u.user }),
        icon: action === 'grant' ? 'shield-plus' : 'shield-minus',
        size: 'wide',
        body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, field(type === 'mysql' ? t('Database') : t('Schema (all tables in it)'), nsSel), field(t('Privileges'), box)),
        actions: ['spacer', { label: t('Cancel') }, { label: t('Continue'), kind: 'primary', onClick: () => (setTimeout(() => run(action, { ...u, ns: nsSel.value, privileges: [...privs] }).catch((e) => toast(e.message, 'err'))), true) }],
      });
    };
    panes.users = h(
      'div',
      { class: 'subpanel' },
      h('div', { class: 'toolbar' }, h('button', { class: 'btn sm primary', html: icon('user-plus') + `<span>${t('New user')}</span>`, onclick: createDialog }), h('button', { class: 'btn sm', html: icon('refresh-cw'), onclick: loadUsers }), h('span', { class: 'info', text: t('Click a row number to see privileges · right-click for actions') })),
      h('div', { style: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '12px', padding: '12px' } }, h('div', { style: { display: 'flex', minHeight: 0, border: '1px solid var(--line)', borderRadius: '12px', overflow: 'hidden' } }, gw), h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, gap: '8px' } }, h('div', { class: 'section-label', text: t('Privileges (GRANT)') }), grants)),
    );
    panes.users.load = () => !users && loadUsers();
  }

  for (const p of Object.values(panes)) panel.append(p);
  const setSub = (k) => {
    subtabs.querySelectorAll('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.sub === k));
    for (const [key, p] of Object.entries(panes)) p.hidden = key !== k;
    panes[k].load?.();
  };
  subtabs.querySelectorAll('.subtab').forEach((b) => (b.onclick = () => setSub(b.dataset.sub)));
  const tab = { kind: 'server', icon: 'server', title: t('Server: {name}', { name: a.conn.name }), panel, connId: a.conn.id, onClose: () => clearInterval(tab.timer) };
  addTab(tab);
  setSub(SUBS[0][0]);
}

Object.assign(app, { openServer });
