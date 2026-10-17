// Connection workspaces: every open connection gets its own big tab with its own explorer, database/schema and
// tabs, so several databases — on different servers or on the same one — stay connected side by side.
import { $, h, icon, api, state, app, emit, on, local, toast, showMenu, confirmDialog, connById, wsById, wsTabs, engineBadge, TYPE_LABEL } from './core.js';
import { activateTab, closeTab, renderTabs } from './tabs.js';
import { motionOK } from './fx.js';
import { t, plural } from './i18n.js';

const newWid = () => 'w' + Math.random().toString(36).slice(2, 10);
const ENGINE_HUE = { mysql: '#ffbe55', postgres: '#5aa2ff', sqlite: '#2dffb3' };
const colorOf = (w) => w.conn.color || ENGINE_HUE[w.conn.type] || '#8b5cff';
const subOf = (w) => (w.conn.type === 'sqlite' ? String(w.conn.file || '').split('/').pop() : w.ns);

function persist() {
  local.set('dbs-workspaces', state.workspaces.map((w) => ({ wid: w.wid, conn: w.conn.id, ns: w.ns })));
  local.set('dbs-ws-active', state.ws);
}

/** Connect and add a workspace. Throws when the connection fails. */
export async function openWorkspace(connId, { ns, wid, activate = true } = {}) {
  const conn = connById(connId);
  if (!conn) return null;
  emit('connecting', connId);
  const info = await api('POST', `/api/c/${connId}/connect`);
  const pick = ns && info.namespaces.includes(ns) ? ns : info.namespaces.includes(info.defaultNs) ? info.defaultNs : info.namespaces[0];
  const w = { wid: wid || newWid(), conn, ...info, ns: pick, tables: [], columns: {}, objects: { routines: [], triggers: [], events: [] }, activeTab: null, born: true };
  state.workspaces.push(w);
  if (activate) switchWorkspace(w.wid);
  else {
    renderWsBar();
    emit('ws');
  }
  persist();
  await app.loadTree(w);
  return w;
}

// Tabs whose workspace is gone (or that were opened before any connection) join the workspace on screen.
function adoptOrphans() {
  for (const x of state.tabs) if (x.ws !== state.ws && !wsById(x.ws)) x.ws = state.ws;
}

export function switchWorkspace(wid, { tabId } = {}) {
  const from = state.workspaces.findIndex((w) => w.wid === state.ws);
  const prev = wsById(state.ws);
  if (prev) prev.activeTab = state.activeTab;
  const changed = state.ws !== wid;
  state.ws = wsById(wid) ? wid : null;
  adoptOrphans();
  const w = wsById(state.ws);
  const mine = wsTabs();
  const want = tabId ?? w?.activeTab;
  const tab = mine.find((x) => x.id === want) || mine.at(-1);
  if (changed) {
    document.documentElement.style.setProperty('--ws-c', w ? colorOf(w) : 'var(--a1)');
    swapAnimation(state.workspaces.findIndex((x) => x.wid === state.ws) >= from ? 'right' : 'left');
  }
  persist();
  renderWsBar();
  emit('ws');
  emit('connected', w?.conn.id ?? null);
  emit('tree');
  if (tab) activateTab(tab.id);
  else {
    state.activeTab = null;
    for (const x of state.tabs) x.panel.hidden = true;
    renderTabs();
    emit('tab');
  }
}

// The explorer and the work area slide in from the side of the workspace being opened.
function swapAnimation(dir) {
  if (!motionOK()) return;
  for (const el of [$('#sidebar'), $('#main')]) {
    el.classList.remove('ws-in-left', 'ws-in-right');
    void el.offsetWidth;
    el.classList.add(`ws-in-${dir}`);
  }
}

/** Close a workspace and its tabs (asks first when work would be lost). */
export async function closeWorkspace(wid = state.ws) {
  const w = wsById(wid);
  if (!w) return false;
  const tabs = state.tabs.filter((x) => x.ws === wid);
  const dirty = tabs.filter((x) => x.isDirty?.()).length;
  const withSql = tabs.filter((x) => x.kind === 'query' && x.cm?.getValue().trim()).length;
  if (
    (dirty || withSql) &&
    !(await confirmDialog({
      title: t('Close {name}?', { name: w.conn.name }),
      message: [
        dirty ? plural(dirty, '{n} tab has unsaved changes.', '{n} tabs have unsaved changes.') : '',
        withSql ? plural(withSql, '{n} query tab with SQL will be closed.', '{n} query tabs with SQL will be closed.') : '',
      ].filter(Boolean).join(' '),
      danger: Boolean(dirty),
      confirmLabel: t('Close connection'),
      icon: 'unplug',
    }))
  )
    return false;
  for (const x of tabs) await closeTab(x.id, true);
  const i = state.workspaces.indexOf(w);
  state.workspaces.splice(i, 1);
  // Other workspaces may share the server connection (same connection, another database).
  if (!state.workspaces.some((x) => x.conn.id === w.conn.id)) api('POST', `/api/c/${w.conn.id}/disconnect`).catch(() => {});
  if (state.ws === wid) {
    state.ws = null;
    const next = state.workspaces[i] || state.workspaces[i - 1];
    switchWorkspace(next?.wid ?? null);
  } else {
    persist();
    renderWsBar();
    emit('ws');
  }
  return true;
}

/** Reopen the workspaces of the previous session (query tabs were restored before this). */
export async function restoreWorkspaces() {
  let saved = local.get('dbs-workspaces', null);
  if (!saved) {
    const last = local.get('dbs-last-conn', null); // 0.3.0 and older remembered a single connection
    saved = last ? [{ conn: last }] : [];
  }
  saved = saved.filter((s) => connById(s.conn));
  if (!saved.length) return;
  const wanted = local.get('dbs-ws-active', null);
  const res = await Promise.allSettled(saved.map((s) => openWorkspace(s.conn, { ns: s.ns, wid: s.wid, activate: false })));
  const order = saved.map((s) => s.wid);
  state.workspaces.sort((a, b) => order.indexOf(a.wid) - order.indexOf(b.wid));
  const failed = res.filter((r) => r.status === 'rejected').length;
  if (failed) toast(plural(failed, '{n} connection could not be reopened.', '{n} connections could not be reopened.'), 'err');
  if (!state.ws) switchWorkspace(wsById(wanted) ? wanted : state.workspaces[0]?.wid ?? null);
}

/** Move between workspaces: +1 / -1 (wraps). */
export function cycleWorkspace(step) {
  const n = state.workspaces.length;
  if (n < 2) return;
  const i = state.workspaces.findIndex((w) => w.wid === state.ws);
  switchWorkspace(state.workspaces[(i + step + n) % n].wid);
}

// ---------------------------------------------------------------- the big tab bar
export function renderWsBar() {
  const bar = $('#wsbar');
  const appEl = $('#app');
  appEl.classList.toggle('has-ws', state.workspaces.length > 0);
  bar.innerHTML = '';
  if (!state.workspaces.length) return;
  const track = h('div', { class: 'ws-track' }, h('div', { class: 'ws-glow' }));
  state.workspaces.forEach((w, i) => {
    const count = state.tabs.filter((x) => x.ws === w.wid).length;
    const chip = h(
      'div',
      {
        class: 'ws-chip' + (w.wid === state.ws ? ' on' : '') + (w.born ? ' born' : ''),
        style: { '--c': colorOf(w) },
        draggable: 'true',
        'data-wid': w.wid,
        title: `${w.conn.name} — ${TYPE_LABEL[w.conn.type]}${w.conn.type !== 'sqlite' ? ' · ' + w.ns : ''}${i < 9 ? `  (Alt+${i + 1})` : ''}`,
      },
      h('span', { class: 'ws-led' }),
      h('span', { html: engineBadge(w.conn.type, true) }),
      h('span', { class: 'ws-text' }, h('b', { text: w.conn.name }), h('span', { class: 'ws-sub', text: subOf(w) })),
      count ? h('span', { class: 'ws-count', text: count }) : null,
      h('button', { class: 'ws-x', title: t('Close connection (middle-click)'), html: icon('x') }),
    );
    w.born = false;
    chip.onclick = () => switchWorkspace(w.wid);
    chip.onauxclick = (e) => e.button === 1 && closeWorkspace(w.wid);
    chip.querySelector('.ws-x').onclick = (e) => {
      e.stopPropagation();
      closeWorkspace(w.wid);
    };
    chip.oncontextmenu = (e) => wsMenu(e, w);
    dragSort(chip, w);
    track.append(chip);
  });
  const add = h('button', { class: 'ws-add', title: t('Open another connection'), html: icon('plus') });
  add.onclick = (e) => addMenu(e);
  bar.append(track, add, h('div', { class: 'ws-hint faint', text: plural(state.workspaces.length, '{n} connection open', '{n} connections open') }));
  requestAnimationFrame(moveGlow);
}

// A soft light that glides behind the active chip.
function moveGlow() {
  const glow = $('#wsbar .ws-glow');
  const on = $('#wsbar .ws-chip.on');
  if (!glow) return;
  if (!on) return void (glow.style.opacity = 0);
  glow.style.opacity = 1;
  glow.style.width = on.offsetWidth + 'px';
  glow.style.transform = `translateX(${on.offsetLeft}px)`;
  glow.style.setProperty('--c', on.style.getPropertyValue('--c'));
}
addEventListener('resize', () => requestAnimationFrame(moveGlow));

let dragging = null;
function dragSort(chip, w) {
  chip.addEventListener('dragstart', (e) => {
    dragging = w;
    chip.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', w.wid);
  });
  chip.addEventListener('dragend', () => {
    dragging = null;
    chip.classList.remove('dragging');
    persist();
    renderWsBar();
  });
  chip.addEventListener('dragover', (e) => {
    if (!dragging || dragging === w) return;
    e.preventDefault();
    const r = chip.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    const list = state.workspaces;
    list.splice(list.indexOf(dragging), 1);
    list.splice(list.indexOf(w) + (after ? 1 : 0), 0, dragging);
    const el = $(`#wsbar .ws-chip[data-wid="${dragging.wid}"]`);
    if (el) after ? chip.after(el) : chip.before(el);
    requestAnimationFrame(moveGlow);
  });
}

function wsMenu(e, w) {
  const others = state.workspaces.filter((x) => x !== w);
  showMenu(e, [
    { label: w.conn.name, header: true },
    { label: t('Refresh'), icon: 'refresh-cw', action: () => app.loadTree(w) },
    w.conn.type !== 'sqlite'
      ? { label: w.conn.type === 'postgres' ? t('Open another schema in a new tab…') : t('Open another database in a new tab…'), icon: 'copy-plus', action: () => nsPicker(e, w) }
      : null,
    { label: t('Edit connection…'), icon: 'settings-2', action: () => app.openConnDialog(w.conn) },
    '-',
    { label: t('Close connection'), icon: 'unplug', action: () => closeWorkspace(w.wid) },
    others.length ? { label: t('Close other connections'), icon: 'copy-x', action: async () => { for (const x of others) await closeWorkspace(x.wid); } } : null,
  ]);
}

/** Pick another database/schema of a workspace's server and open it next to the current one. */
export function nsPicker(e, w = state.active) {
  if (!w) return;
  const list = w.namespaces.filter((n) => !state.workspaces.some((x) => x.conn.id === w.conn.id && x.ns === n));
  showMenu(e, [
    { label: w.conn.type === 'postgres' ? t('Open schema in a new tab') : t('Open database in a new tab'), header: true },
    ...list.map((n) => ({ label: n, icon: 'database', action: () => openFresh(w.conn.id, n) })),
    list.length ? null : { label: t('All of them are already open'), icon: 'check', disabled: true, action: () => {} },
  ]);
}

async function openFresh(connId, ns) {
  try {
    await openWorkspace(connId, { ns });
    if (!wsTabs().length) app.newQueryTab();
  } catch (err) {
    toast(err.message, 'err', { title: t('Could not connect to {name}', { name: connById(connId)?.name || '' }) });
  }
}

function addMenu(e) {
  const openIds = new Set(state.workspaces.map((w) => w.conn.id));
  const items = [...state.conns].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (b.lastUsed || 0) - (a.lastUsed || 0));
  showMenu(e, [
    { label: t('Open a connection'), header: true },
    ...items.map((c) => ({
      label: openIds.has(c.id) ? t('{name} — open again', { name: c.name }) : c.name,
      icon: c.favorite ? 'star' : c.type === 'sqlite' ? 'file-box' : 'database',
      action: () => (openIds.has(c.id) ? app.connect(c.id, { fresh: true }) : app.connect(c.id)),
    })),
    '-',
    { label: t('New connection…'), icon: 'plug-zap', action: () => app.openConnDialog() },
  ]);
}

// An edited connection (name, color…) shows up on its open workspaces at once.
on('conns', () => {
  for (const w of state.workspaces) w.conn = connById(w.conn.id) || w.conn;
  renderWsBar();
});

on('tab', () => {
  // keep tab counts on the chips current
  for (const chip of document.querySelectorAll('#wsbar .ws-chip')) {
    const n = state.tabs.filter((x) => x.ws === chip.dataset.wid).length;
    let c = chip.querySelector('.ws-count');
    if (!n) c?.remove();
    else if (c) c.textContent = n;
    else chip.querySelector('.ws-x').before(h('span', { class: 'ws-count', text: n }));
  }
});

Object.assign(app, { openWorkspace, switchWorkspace, closeWorkspace, restoreWorkspaces, cycleWorkspace, renderWsBar, nsPicker });
