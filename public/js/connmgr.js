// Connection manager: favourites, groups (folders), search, sort, drag & drop, import / export.
import { $, h, icon, esc, api, state, app, on, local, toast, modal, showMenu, promptDialog, checkbox, toggle, field, segmented, select, fmtNum, timeAgo, TYPE_LABEL, engineBadge, downloadText } from './core.js';
import { connCard } from './sidebar.js';
import { connSub } from './conn.js';
import { stagger } from './fx.js';
import { t, plural, LOCALE } from './i18n.js';

const collapsed = new Set(local.get('dbs-groups-collapsed', []));
let query = '';
let sort = local.get('dbs-conn-sort', 'name');

export const groupsOf = () => [...new Set(state.conns.map((c) => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));

async function patch(ids, fields) {
  await api('POST', '/api/connections/patch', { ids, fields });
  await app.loadConns();
}

export const toggleFavorite = (c) => patch([c.id], { favorite: !c.favorite });

export async function moveToGroup(conns, group) {
  await patch(conns.map((c) => c.id), { group: group || null });
  toast(group ? t('Moved to group "{group}"', { group }) : t('Removed from group'), 'ok', { timeout: 1600 });
}

export function groupPicker(e, conns) {
  const current = conns.length === 1 ? conns[0].group : null;
  showMenu(e, [
    { label: t('Move to group'), header: true },
    ...groupsOf().map((g) => ({ label: g, icon: g === current ? 'check' : 'folder', action: () => moveToGroup(conns, g) })),
    groupsOf().length ? '-' : null,
    {
      label: t('New group…'),
      icon: 'folder-plus',
      action: async () => {
        newGroupDialog(conns.map((c) => c.id));
      },
    },
    current ? { label: t('Remove from group'), icon: 'folder-minus', action: () => moveToGroup(conns, null) } : null,
  ]);
}

function matches(c) {
  if (!query) return true;
  const hay = `${c.name} ${c.group || ''} ${connSub(c)} ${TYPE_LABEL[c.type]} ${c.database || ''} ${c.ssh?.host || ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}
const sorter = (a, b) => (sort === 'recent' ? (b.lastUsed || 0) - (a.lastUsed || 0) : a.name.localeCompare(b.name, LOCALE));

function dropTarget(el, group) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-dbstudio-conn')) return;
    e.preventDefault();
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-over');
    const id = e.dataTransfer.getData('application/x-dbstudio-conn');
    const c = state.conns.find((x) => x.id === id);
    if (c && (c.group || null) !== (group || null)) moveToGroup([c], group);
  });
}

function card(c) {
  const el = connCard(c);
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-dbstudio-conn', c.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
    $('#conn-list').classList.add('dnd');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    $('#conn-list').classList.remove('dnd');
  });
  return el;
}

function groupSection(key, title, ico, items, { group = null, droppable = true, actions = [] } = {}) {
  const sec = h('div', { class: 'cg' + (collapsed.has(key) ? ' collapsed' : '') });
  const head = h(
    'div',
    { class: 'cg-head' },
    h('span', { html: icon('chevron-down', 'chev') }),
    h('span', { class: 'cg-ico', html: icon(ico) }),
    h('span', { class: 'cg-title', text: title }),
    ...actions,
    h('span', { class: 'count', text: String(items.length) }),
  );
  head.onclick = (e) => {
    if (e.target.closest('.btn')) return;
    sec.classList.toggle('collapsed');
    sec.classList.contains('collapsed') ? collapsed.add(key) : collapsed.delete(key);
    local.set('dbs-groups-collapsed', [...collapsed]);
  };
  if (group) {
    head.oncontextmenu = (e) =>
      showMenu(e, [
        { label: group, header: true },
        { label: t('Rename group…'), icon: 'pencil', action: () => renameGroup(group) },
        { label: t('Export this group\'s connections…'), icon: 'upload', action: () => openExportDialog({ ids: items.map((c) => c.id) }) },
        '-',
        { label: t('Ungroup'), icon: 'folder-minus', action: () => api('POST', '/api/connections/group-rename', { from: group, to: '' }).then(app.loadConns) },
      ]);
  }
  const list = h('div', { class: 'cg-list' });
  items.forEach((c) => list.append(card(c)));
  stagger(list);
  sec.append(head, h('div', { class: 'tree-body' }, h('div', {}, list)));
  if (droppable) dropTarget(sec, group);
  return sec;
}

async function renameGroup(group) {
  const name = await promptDialog({ title: t('Rename group'), label: t('Group name'), value: group, icon: 'folder-pen' });
  if (!name || name === group) return;
  await api('POST', '/api/connections/group-rename', { from: group, to: name });
  if (collapsed.delete(`g:${group}`)) collapsed.add(`g:${name}`);
  await app.loadConns();
}

export function renderConnections() {
  const box = $('#conn-list');
  if (!box) return;
  box.innerHTML = '';
  if (!state.conns.length) {
    box.append(
      h(
        'div',
        { class: 'empty' },
        h('div', { html: icon('plug') }),
        h('div', { text: t('No saved connections yet.') }),
        h('button', { class: 'btn primary sm', html: icon('plus') + `<span>${t('New connection')}</span>`, onclick: () => app.openConnDialog() }),
        h('button', { class: 'btn sm', html: icon('download') + `<span>${t('Import connections')}</span>`, onclick: () => openImportDialog() }),
        h('button', { class: 'btn sm ghost', html: icon('sparkles') + `<span>${t('Try the demo database')}</span>`, onclick: () => app.openDemo() }),
      ),
    );
    return;
  }
  const visible = state.conns.filter(matches).sort(sorter);
  if (!visible.length) {
    box.append(h('div', { class: 'empty', html: `${icon('search-x')}<div>${t('No connections match "{query}".', { query: esc(query) })}</div>` }));
    return;
  }
  const favs = visible.filter((c) => c.favorite);
  if (favs.length) box.append(groupSection('fav', t('Favorites'), 'star', favs, { droppable: false }));
  for (const g of groupsOf()) {
    const items = visible.filter((c) => c.group === g);
    if (!items.length && query) continue;
    box.append(
      groupSection(`g:${g}`, g, 'folder', items, {
        group: g,
        actions: [h('button', { class: 'btn ghost xs icon head-act', title: t('Group actions'), html: icon('ellipsis'), onclick: (e) => (e.stopPropagation(), e.currentTarget.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY }))) })],
      }),
    );
  }
  const loose = visible.filter((c) => !c.group);
  if (loose.length) box.append(groupSection('none', groupsOf().length ? t('No group') : t('All connections'), 'database', loose, { group: null }));
}

export function initConnPanel() {
  const panel = $('.side-panel[data-panel="connections"]');
  const search = h('input', { class: 'input sm', placeholder: t('Search connections, hosts, groups…'), value: query });
  search.oninput = () => {
    query = search.value.trim();
    renderConnections();
  };
  const sortBtn = h('button', { class: 'btn ghost xs icon', title: '', html: '' });
  const syncSort = () => {
    sortBtn.innerHTML = icon(sort === 'recent' ? 'clock' : 'arrow-down-a-z');
    sortBtn.title = sort === 'recent' ? t('Sort: recently used') : t('Sort: name');
  };
  syncSort();
  sortBtn.onclick = () => {
    sort = sort === 'recent' ? 'name' : 'recent';
    local.set('dbs-conn-sort', sort);
    syncSort();
    renderConnections();
  };
  const more = h('button', { class: 'btn ghost xs icon', title: t('Import, export & groups'), html: icon('ellipsis-vertical') });
  more.onclick = (e) =>
    showMenu(e, [
      { label: t('Connections'), header: true },
      { label: t('Import connections…'), icon: 'download', action: () => openImportDialog() },
      { label: t('Export connections…'), icon: 'upload', action: () => openExportDialog() },
      '-',
      { label: t('New group…'), icon: 'folder-plus', action: () => newGroupDialog() },
      { label: t('Try the demo database'), icon: 'sparkles', action: () => app.openDemo() },
    ]);
  panel.querySelector('.side-head').append(sortBtn, more);
  panel.insertBefore(h('div', { class: 'tree-filter' }, h('div', { class: 'search', html: icon('search') }, search)), $('#conn-list'));
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f' && !panel.hidden) {
      e.preventDefault();
      search.focus();
    }
  });
  on('conns', renderConnections);
  on('connected', renderConnections);
  on('connect-failed', renderConnections);
}

export async function newGroupDialog(preselect = []) {
  const name = await promptDialog({ title: t('New group'), label: t('Group name'), placeholder: t('e.g. Production, Client A, Local'), icon: 'folder-plus', confirmLabel: t('Continue') });
  if (!name) return;
  const chosen = new Set(preselect);
  const list = h('div', { class: 'xp-list' });
  state.conns.forEach((c, i) =>
    list.append(
      h('div', { class: 'xp-row', style: { '--i': i } },
        checkbox('', chosen.has(c.id), (v) => (v ? chosen.add(c.id) : chosen.delete(c.id))),
        h('span', { html: engineBadge(c.type, true) }),
        h('span', { class: 'grow', html: `<b>${esc(c.name)}</b> <span class="faint">${esc(c.group ? t('group: {name}', { name: c.group }) : connSub(c))}</span>` })),
    ),
  );
  modal({
    title: t('Add connections to "{name}"', { name }),
    sub: t('Choose the connections that go into this group'),
    icon: 'folder-plus',
    body: list,
    actions: ['spacer', { label: t('Cancel') }, { label: t('Create group'), kind: 'primary', onClick: async () => {
      if (!chosen.size) throw new Error(t('Select at least one connection — empty groups are not saved'));
      await moveToGroup(state.conns.filter((c) => chosen.has(c.id)), name);
    } }],
  });
}

// ---------------------------------------------------------------- export
export function openExportDialog({ ids = null } = {}) {
  if (!state.conns.length) return toast(t('No connections to export yet'), 'err');
  const chosen = new Set(ids || state.conns.map((c) => c.id));
  const list = h('div', { class: 'xp-list' });
  const renderList = () => {
    list.innerHTML = '';
    const groups = [...groupsOf(), null];
    for (const g of groups) {
      const items = state.conns.filter((c) => (c.group || null) === g);
      if (!items.length) continue;
      const all = items.every((c) => chosen.has(c.id));
      list.append(
        h(
          'div',
          { class: 'xp-group' },
          checkbox(g || t('No group'), all, (v) => {
            items.forEach((c) => (v ? chosen.add(c.id) : chosen.delete(c.id)));
            renderList();
          }),
        ),
      );
      items.forEach((c, i) =>
        list.append(
          h(
            'div',
            { class: 'xp-row', style: { '--i': i } },
            checkbox('', chosen.has(c.id), (v) => {
              v ? chosen.add(c.id) : chosen.delete(c.id);
              renderList();
            }),
            h('span', { html: engineBadge(c.type, true) }),
            h('span', { class: 'grow', html: `<b>${esc(c.name)}</b> <span class="faint">${esc(connSub(c))}</span>` }),
            c.ssh?.enabled ? h('span', { class: 'chip', html: icon('shield-check') + 'SSH' }) : null,
          ),
        ),
      );
    }
    count.textContent = plural(state.conns.length, '{selected} of {n} connection selected', '{selected} of {n} connections selected', { selected: fmtNum(chosen.size) });
  };
  const count = h('span', { class: 'faint' });
  const pw = toggle(t('Include database & SSH passwords'), true, () => sync());
  const p1 = h('input', { class: 'input', type: 'password', placeholder: t('Passphrase (recommended)'), autocomplete: 'new-password' });
  const p2 = h('input', { class: 'input', type: 'password', placeholder: t('Repeat passphrase'), autocomplete: 'new-password' });
  const meter = h('div', { class: 'pw-meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 4 }, h('i'));
  const hint = h('div', { class: 'hint' });
  const sync = () => {
    const s = strength(p1.value);
    meter.firstChild.style.width = `${s * 25}%`;
    meter.dataset.level = s;
    meter.title = STRENGTH[s];
    meter.setAttribute('aria-valuenow', s);
    meter.setAttribute('aria-label', STRENGTH[s] || t('Passphrase strength'));
    hint.innerHTML = !pw.input.checked
      ? `${icon('info')} ${t('Passwords are not included — the recipient has to fill them in.')}`
      : p1.value
        ? `${icon('lock')} ${t('The file is encrypted with AES-256-GCM. Without the passphrase its contents cannot be read.')}`
        : `<span class="warn-text">${icon('triangle-alert')} ${t('Without a passphrase, passwords are stored as plain text in the file.')}</span>`;
  };
  p1.oninput = sync;
  renderList();
  sync();
  modal({
    title: t('Export connections'),
    sub: t('Move connections to another computer or keep them as a backup'),
    icon: 'upload',
    size: 'wide',
    body: h(
      'div',
      { class: 'xp' },
      h('div', { class: 'row' }, h('div', { class: 'section-label grow', text: t('Select connections') }), count),
      list,
      h('div', { class: 'form-grid' }, h('div', { class: 'full' }, pw), field('Passphrase', p1), field(t('Confirm'), p2), h('div', { class: 'full' }, meter, hint)),
    ),
    actions: [
      'spacer',
      { label: t('Cancel') },
      {
        label: t('Export'),
        kind: 'primary',
        icon: 'upload',
        onClick: async () => {
          if (!chosen.size) throw new Error(t('Select at least one connection'));
          if (p1.value !== p2.value) throw new Error(t('Passphrases do not match'));
          const r = await api('POST', '/api/connections/export', { ids: [...chosen], includePasswords: pw.input.checked, passphrase: p1.value });
          downloadText(`dbstudio-connections-${new Date().toISOString().slice(0, 10)}.json`, r.content, 'application/json');
          toast(p1.value ? plural(r.count, '{n} connection exported (encrypted)', '{n} connections exported (encrypted)') : plural(r.count, '{n} connection exported', '{n} connections exported'), 'ok');
        },
      },
    ],
  });
}

const STRENGTH = ['', t('Weak passphrase'), t('Fair passphrase'), t('Good passphrase'), t('Strong passphrase')];

function strength(p) {
  if (!p) return 0;
  let s = p.length >= 8 ? 1 : 0;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  return Math.max(1, Math.min(4, s));
}

// ---------------------------------------------------------------- import
export function openImportDialog() {
  let mainFile = null;
  let credFile = null;
  let preview = null;
  const picked = new Set();
  const body = h('div', { class: 'xp' });
  const zone = h(
    'label',
    { class: 'dropzone' },
    h('div', { html: icon('file-input') }),
    h('div', { html: t('<b>Choose a connection file</b> — or drop it here') }),
    h('div', { class: 'formats' }, ...['DBStudio .json', 'Navicat .ncx', 'DBeaver data-sources.json'].map((f) => h('span', { class: 'chip', text: f }))),
  );
  const input = h('input', { type: 'file', accept: '.json,.ncx,.xml', hidden: true });
  zone.append(input);
  const credRow = h(
    'div',
    { class: 'notice info', hidden: true },
    h('span', { html: icon('key-round') }),
    h('div', { class: 'grow', html: t('DBeaver keeps the user and password in <span class="mono">credentials-config.json</span> (same folder). Add it so they are imported too.') }),
    h('label', { class: 'btn sm', html: `${icon('paperclip')}<span>${t('Choose file')}</span>` }, h('input', { type: 'file', accept: '.json', hidden: true, onchange: async (e) => ((credFile = e.target.files[0]), credRow.querySelector('.btn span').textContent = credFile.name, await parse()) })),
  );
  const passRow = h('div', { class: 'form-grid', hidden: true });
  const pass = h('input', { class: 'input', type: 'password', placeholder: t('Passphrase for this file'), autocomplete: 'off' });
  passRow.append(h('div', { class: 'full' }, field(t('Encrypted file — enter the passphrase'), h('div', { class: 'row' }, pass, h('button', { class: 'btn primary', html: icon('lock-open') + `<span>${t('Unlock')}</span>`, onclick: () => parse() })))));
  pass.addEventListener('keydown', (e) => e.key === 'Enter' && parse());
  const result = h('div');
  const groupSel = h('input', { class: 'input', list: 'grp-list', placeholder: t('No group (optional)') });
  const groupList = h('datalist', { id: 'grp-list' }, ...groupsOf().map((g) => h('option', { value: g })));
  body.append(zone, credRow, passRow, result);

  const take = async (f) => {
    if (!f) return;
    mainFile = f;
    zone.classList.add('has-file');
    zone.querySelector('div:nth-child(2)').innerHTML = `${icon('file-check-2')} <b>${esc(f.name)}</b>`;
    await parse();
  };
  input.onchange = () => take(input.files[0]);
  zone.addEventListener('dragover', (e) => (e.preventDefault(), zone.classList.add('over')));
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    take(e.dataTransfer.files[0]);
  });

  async function parse() {
    if (!mainFile) return;
    result.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      const content = await mainFile.text();
      const credentials = credFile ? btoa(String.fromCharCode(...new Uint8Array(await credFile.arrayBuffer()))) : '';
      preview = await api('POST', '/api/connections/import/preview', { content, filename: mainFile.name, passphrase: pass.value, credentials });
      passRow.hidden = true;
      credRow.hidden = preview.source !== 'DBeaver';
      picked.clear();
      preview.items.forEach((it, i) => !it.skip && !it.duplicate && picked.add(i));
      renderPreview();
    } catch (e) {
      result.innerHTML = '';
      if (e.code === 'NEED_PASSPHRASE' || e.code === 'BAD_PASSPHRASE') {
        passRow.hidden = false;
        pass.focus();
        if (pass.value) result.append(h('div', { class: 'result-error', text: e.message }));
        return;
      }
      result.append(h('div', { class: 'result-error', text: e.message }));
    }
  }

  function renderPreview() {
    result.innerHTML = '';
    const items = preview.items;
    const ok = items.filter((i) => !i.skip).length;
    const head = h(
      'div',
      { class: 'row', style: { margin: '6px 0 8px' } },
      h('span', { class: 'chip info', html: `${icon('badge-check')} ${esc(preview.source)}` }),
      h('span', { class: 'faint', text: plural(ok, '{n} connection can be imported', '{n} connections can be imported') + (items.length - ok ? ' · ' + plural(items.length - ok, '{n} skipped', '{n} skipped') : '') }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn xs', text: t('All'), onclick: () => (items.forEach((it, i) => !it.skip && picked.add(i)), renderPreview()) }),
      h('button', { class: 'btn xs', text: t('None'), onclick: () => (picked.clear(), renderPreview()) }),
    );
    const list = h('div', { class: 'xp-list' });
    items.forEach((it, i) => {
      const where = it.type === 'sqlite' ? it.file : `${it.user ? it.user + '@' : ''}${it.host}:${it.port}${it.database ? '/' + it.database : ''}`;
      const row = h(
        'div',
        { class: 'xp-row' + (it.skip ? ' skip' : ''), style: { '--i': i } },
        it.skip ? h('span', { html: icon('ban') }) : checkbox('', picked.has(i), (v) => (v ? picked.add(i) : picked.delete(i), renderFoot())),
        it.type ? h('span', { html: engineBadge(it.type, true) }) : h('span', { class: 'engine sm', text: '?' }),
        h(
          'div',
          { class: 'grow', style: { minWidth: 0 } },
          h('div', { html: `<b>${esc(it.name)}</b> <span class="faint mono">${esc(where || '')}</span>` }),
          it.warnings.length ? h('div', { class: 'xp-warn', html: it.warnings.map((w) => `${icon('triangle-alert')} ${esc(w)}`).join('<br>') }) : null,
        ),
        it.duplicate ? h('span', { class: 'chip warn', text: t('already exists') }) : null,
        it.ssh?.enabled ? h('span', { class: 'chip', html: icon('shield-check') + 'SSH' }) : null,
        !it.skip && it.type !== 'sqlite' ? h('span', { class: `chip ${it.hasPassword ? 'ok' : ''}`, html: icon(it.hasPassword ? 'key-round' : 'key') + (it.hasPassword ? t('password') : t('no password')) }) : null,
      );
      list.append(row);
    });
    result.append(head, list, h('div', { class: 'form-grid', style: { marginTop: '12px' } }, h('div', { class: 'full' }, field(t('Add to group'), groupSel, t('Leave empty to use the groups from the file (if any).')), groupList)));
    renderFoot();
  }
  function renderFoot() {
    const b = m.foot.querySelector('.btn.primary');
    b.disabled = !preview || !picked.size;
    b.querySelector('span').textContent = picked.size ? plural(picked.size, 'Import {n} connection', 'Import {n} connections') : t('Import');
  }

  const m = modal({
    title: t('Import connections'),
    sub: t('From DBStudio, Navicat or DBeaver'),
    icon: 'download',
    size: 'wide',
    body,
    actions: [
      'spacer',
      { label: t('Cancel') },
      {
        label: t('Import'),
        kind: 'primary',
        icon: 'download',
        onClick: async () => {
          const r = await api('POST', '/api/connections/import/commit', { id: preview.id, indices: [...picked], group: groupSel.value.trim() });
          await app.loadConns();
          toast(plural(r.imported, '{n} connection added', '{n} connections added'), 'ok', { title: t('Import complete') });
          app.showPanel('connections');
        },
      },
    ],
  });
  renderFoot();
  void segmented;
  void select;
  void timeAgo;
}

Object.assign(app, { openImportDialog, openExportDialog, toggleFavorite, moveToGroup, groupPicker, newGroupDialog, renderConnections });
