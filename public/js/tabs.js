// Tab manager: query, table, designer, ERD and tool tabs all live here.
import { $, h, icon, state, app, emit, currentTab, wsTabs, showMenu, confirmDialog, esc } from './core.js';
import { t } from './i18n.js';

export function addTab(tab, { activate = true } = {}) {
  tab.id = ++state.seq;
  // A tab lives in the workspace (open connection) it was created in.
  if (tab.ws === undefined) tab.ws = state.ws;
  tab.panel.classList.add('tab-panel');
  tab.fresh = true;
  state.tabs.push(tab);
  $('#tab-content').append(tab.panel);
  if (activate) activateTab(tab.id);
  else {
    tab.panel.hidden = true;
    renderTabs();
  }
  return tab;
}

export function activateTab(id) {
  const target = state.tabs.find((x) => x.id === id);
  // Activating a tab of another workspace (palette, job links…) brings that workspace on screen first.
  if (target && target.ws !== state.ws && app.switchWorkspace) return app.switchWorkspace(target.ws, { tabId: id });
  const changed = state.activeTab !== id;
  state.activeTab = id;
  for (const x of state.tabs) x.panel.hidden = x.id !== id;
  const tab = currentTab();
  if (tab && changed) {
    tab.panel.classList.remove('entering');
    void tab.panel.offsetWidth;
    tab.panel.classList.add('entering');
  }
  renderTabs();
  try {
    tab?.onActivate?.();
  } catch (err) {
    // A tab whose widgets are still being built must not break tab switching.
    console.warn('onActivate', err);
  }
  emit('tab');
}

export async function closeTab(id, force = false) {
  const i = state.tabs.findIndex((x) => x.id === id);
  if (i < 0) return true;
  const tab = state.tabs[i];
  if (!force && tab.isDirty?.()) {
    const ok = await confirmDialog({
      title: t('Close without saving?'),
      message: t('Tab <b>{title}</b> has unsaved changes.', { title: esc(tab.title) }),
      danger: true,
      confirmLabel: t('Discard & close'),
    });
    if (!ok) return false;
  }
  // Neighbours within the same workspace take over when the active tab closes.
  const siblings = state.tabs.filter((x) => x.ws === tab.ws);
  const j = siblings.indexOf(tab);
  tab.onClose?.();
  tab.panel.remove();
  state.tabs.splice(i, 1);
  if (state.activeTab === id) {
    const n = siblings[j + 1] || siblings[j - 1];
    state.activeTab = n?.id ?? null;
    if (n) activateTab(n.id);
  }
  renderTabs();
  emit('tab');
  emit('tabs-changed');
  return true;
}

export function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  const visible = wsTabs();
  for (const tab of visible) {
    const el = h(
      'div',
      {
        class: 'tab' + (tab.id === state.activeTab ? ' active' : '') + (tab.isDirty?.() ? ' dirty' : '') + (tab.fresh ? ' entering' : ''),
        title: tab.tooltip || tab.title,
      },
      h('span', { class: 't-ico', html: icon(tab.icon || 'file') }),
      h('span', { class: 't-title', text: tab.title }),
      h('button', { class: 't-close', title: t('Close (middle-click)'), html: icon('x') }),
    );
    tab.fresh = false;
    el.onclick = () => activateTab(tab.id);
    el.onauxclick = (e) => {
      if (e.button === 1) closeTab(tab.id);
    };
    el.querySelector('.t-close').onclick = (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    };
    el.oncontextmenu = (e) =>
      showMenu(e, [
        tab.rename ? { label: t('Rename…'), icon: 'pencil', action: () => tab.rename() } : null,
        { label: t('Close'), icon: 'x', action: () => closeTab(tab.id) },
        { label: t('Close other tabs'), icon: 'copy-x', action: async () => { for (const x of wsTabs().filter((x) => x.id !== tab.id)) await closeTab(x.id); } },
        { label: t('Close all'), icon: 'circle-x', action: async () => { for (const x of wsTabs()) await closeTab(x.id); } },
      ]);
    box.append(el);
  }
  $('#welcome').hidden = visible.length > 0;
  requestAnimationFrame(moveIndicator);
}

export function moveIndicator() {
  const ind = $('#tab-indicator');
  const el = $('#tabs .tab.active');
  if (!ind) return;
  if (!el) {
    ind.style.opacity = 0;
    return;
  }
  const bar = $('#tabbar').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  ind.style.opacity = 1;
  ind.style.width = Math.max(20, r.width - 20) + 'px';
  ind.style.transform = `translateX(${r.left - bar.left + 10}px)`;
}

export function findTab(pred) {
  return state.tabs.find(pred);
}

addEventListener('resize', () => requestAnimationFrame(moveIndicator));
document.addEventListener('DOMContentLoaded', () => $('#tabs')?.addEventListener('scroll', () => requestAnimationFrame(moveIndicator), { passive: true }));
