// Server tools: process list (kill), variables, status, users & privileges.
import { h, icon, esc, api, qs, state, app, toast, modal, sqlPreview, confirmDialog, toggle, checkbox, field, select, TYPE_LABEL, showMenu } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { renderGrid } from './grid.js';

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
    ['proc', 'Proses', 'activity', !sqlite],
    ['vars', sqlite ? 'Pragma' : 'Variabel', 'sliders-horizontal', true],
    ['status', 'Status', 'gauge', true],
    ['users', 'Pengguna', 'users', !sqlite],
  ].filter((x) => x[3]);
  const panes = {};
  for (const [k, label, ico] of SUBS) subtabs.append(h('button', { class: 'subtab', 'data-sub': k, html: icon(ico) + label }));
  subtabs.append(h('span', { class: 'spacer' }), h('span', { class: 'chip', html: `${icon('server')} ${esc(a.conn.name)} · ${TYPE_LABEL[type]} ${esc(String(a.version || '').split(' ')[0])}` }));
  panel.append(subtabs);

  // ---- processes
  if (!sqlite) {
    const gw = h('div', { class: 'grid-wrap' });
    const auto = toggle('Refresh otomatis (3 dtk)', false, (v) => {
      clearInterval(tab.timer);
      if (v) tab.timer = setInterval(() => !panes.proc.hidden && !panel.hidden && loadProc(), 3000);
    });
    const count = h('span', { class: 'chip' });
    const loadProc = async () => {
      try {
        const r = await api('GET', `/api/c/${a.conn.id}/server/processes`);
        count.textContent = `${r.rows.length} koneksi`;
        renderGrid(gw, {
          columns: r.columns,
          rows: r.rows,
          onCellMenu: (e, row) =>
            showMenu(e, [
              { label: `Proses #${r.rows[row][0]}`, header: true },
              { label: 'Hentikan query (KILL QUERY)', icon: 'square', action: () => kill(r.rows[row][0], 'query') },
              { label: 'Putuskan koneksi (KILL)', icon: 'unplug', danger: true, action: () => kill(r.rows[row][0], 'connection') },
            ]),
        });
      } catch (e) {
        gw.innerHTML = '';
        gw.append(h('div', { class: 'result-error', text: e.message }));
      }
    };
    const kill = async (pid, mode) => {
      const ok = await confirmDialog({ title: mode === 'query' ? 'Hentikan query?' : 'Putuskan koneksi?', message: `Proses <b>#${esc(pid)}</b> akan ${mode === 'query' ? 'dihentikan query-nya' : 'diputus'}.`, danger: true, confirmLabel: 'Ya' });
      if (!ok) return;
      try {
        await api('POST', `/api/c/${a.conn.id}/server/kill`, { pid, mode });
        toast(`Proses #${pid} dihentikan`, 'ok');
        loadProc();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
    panes.proc = h('div', { class: 'subpanel' }, h('div', { class: 'toolbar' }, h('button', { class: 'btn sm', html: icon('refresh-cw') + '<span>Refresh</span>', onclick: loadProc }), auto, count, h('span', { class: 'spacer' }), h('span', { class: 'info', text: 'Klik kanan baris untuk menghentikan proses' })), gw);
    panes.proc.load = loadProc;
  }

  // ---- variables / status (filterable key-value grids)
  const kvPane = (url, label) => {
    const gw = h('div', { class: 'grid-wrap' });
    const filter = h('input', { class: 'input sm', placeholder: `Cari ${label}…`, style: { width: '260px' } });
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
  panes.vars = kvPane(`/api/c/${a.conn.id}/server/variables`, 'variabel');
  panes.status = kvPane(`/api/c/${a.conn.id}/server/status`, 'status');

  // ---- users
  if (!sqlite) {
    const gw = h('div', { class: 'grid-wrap' });
    const grants = h('div', { class: 'log', style: { maxHeight: 'none', flex: 1 } });
    let users = null;
    let sel = null;
    const showGrants = async (u) => {
      sel = u;
      grants.innerHTML = `<div class="faint">Memuat hak akses ${esc(u.user)}…</div>`;
      try {
        const r = await api('GET', `/api/c/${a.conn.id}/server/grants${qs({ user: u.user, host: u.host })}`);
        grants.innerHTML = r.grants.length ? r.grants.map((g) => `<div>${esc(g)}</div>`).join('') : '<div class="faint">Tidak ada hak akses eksplisit.</div>';
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
              { label: 'Beri hak akses (GRANT)…', icon: 'shield-plus', action: () => grantDialog(u, 'grant') },
              { label: 'Cabut hak akses (REVOKE)…', icon: 'shield-minus', action: () => grantDialog(u, 'revoke') },
              { label: 'Ubah password…', icon: 'key-round', action: () => passwordDialog(u) },
              '-',
              { label: 'Hapus user…', icon: 'user-x', danger: true, action: () => run('drop', u) },
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
      const ok = await sqlPreview({ title: { create: 'Buat user', drop: 'Hapus user', grant: 'Beri hak akses', revoke: 'Cabut hak akses', password: 'Ubah password' }[action], statements, connId: a.conn.id, type, danger: action === 'drop', confirmLabel: 'Jalankan' });
      if (ok) {
        toast('Selesai', 'ok');
        loadUsers();
        if (sel) showGrants(sel);
      }
    };
    const createDialog = () => {
      const user = h('input', { class: 'input mono', placeholder: 'nama_user' });
      const host = h('input', { class: 'input mono', value: '%', placeholder: '% atau localhost' });
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
      modal({
        title: 'User baru',
        icon: 'user-plus',
        body: h('div', { class: 'form-grid' }, field('Nama user', user), type === 'mysql' ? field('Host', host, '<span class="mono">%</span> = dari mana saja') : h('span'), h('div', { class: 'full' }, field('Password', pw))),
        actions: ['spacer', { label: 'Batal' }, { label: 'Lanjut', kind: 'primary', onClick: () => (setTimeout(() => run('create', { user: user.value.trim(), host: host.value.trim(), password: pw.value }).catch((e) => toast(e.message, 'err'))), true) }],
      });
    };
    const passwordDialog = (u) => {
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
      modal({ title: `Password untuk ${u.user}`, icon: 'key-round', body: field('Password baru', pw), actions: ['spacer', { label: 'Batal' }, { label: 'Lanjut', kind: 'primary', onClick: () => (setTimeout(() => run('password', { ...u, password: pw.value }).catch((e) => toast(e.message, 'err'))), true) }] });
    };
    const grantDialog = (u, action) => {
      const privs = new Set(['SELECT']);
      const box = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' } });
      for (const p of type === 'mysql' ? MYSQL_PRIVS : PG_PRIVS) box.append(checkbox(p, privs.has(p), (v) => (v ? privs.add(p) : privs.delete(p))));
      const nsSel = select(type === 'mysql' ? [{ value: '*', label: '*  (semua database)' }, ...state.active.namespaces.map((n) => ({ value: n, label: n }))] : state.active.namespaces.map((n) => ({ value: n, label: n })), state.active.ns);
      modal({
        title: `${action === 'grant' ? 'GRANT ke' : 'REVOKE dari'} ${u.user}`,
        icon: action === 'grant' ? 'shield-plus' : 'shield-minus',
        size: 'wide',
        body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, field(type === 'mysql' ? 'Database' : 'Schema (semua tabel di dalamnya)', nsSel), field('Hak akses', box)),
        actions: ['spacer', { label: 'Batal' }, { label: 'Lanjut', kind: 'primary', onClick: () => (setTimeout(() => run(action, { ...u, ns: nsSel.value, privileges: [...privs] }).catch((e) => toast(e.message, 'err'))), true) }],
      });
    };
    panes.users = h(
      'div',
      { class: 'subpanel' },
      h('div', { class: 'toolbar' }, h('button', { class: 'btn sm primary', html: icon('user-plus') + '<span>User baru</span>', onclick: createDialog }), h('button', { class: 'btn sm', html: icon('refresh-cw'), onclick: loadUsers }), h('span', { class: 'info', text: 'Klik nomor baris untuk melihat hak akses · klik kanan untuk aksi' })),
      h('div', { style: { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '12px', padding: '12px' } }, h('div', { style: { display: 'flex', minHeight: 0, border: '1px solid var(--line)', borderRadius: '12px', overflow: 'hidden' } }, gw), h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, gap: '8px' } }, h('div', { class: 'section-label', text: 'Hak akses (GRANT)' }), grants)),
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
  const tab = { kind: 'server', icon: 'server', title: `Server: ${a.conn.name}`, panel, connId: a.conn.id, onClose: () => clearInterval(tab.timer) };
  addTab(tab);
  setSub(SUBS[0][0]);
}

Object.assign(app, { openServer });
