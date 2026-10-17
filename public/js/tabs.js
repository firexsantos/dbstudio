// Tab manager: query, table, designer, ERD and tool tabs all live here.
import { $, h, icon, state, emit, currentTab, showMenu, confirmDialog, esc } from './core.js';

export function addTab(tab, { activate = true } = {}) {
  tab.id = ++state.seq;
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
  const changed = state.activeTab !== id;
  state.activeTab = id;
  for (const t of state.tabs) t.panel.hidden = t.id !== id;
  const t = currentTab();
  if (t && changed) {
    t.panel.classList.remove('entering');
    void t.panel.offsetWidth;
    t.panel.classList.add('entering');
  }
  renderTabs();
  t?.onActivate?.();
  emit('tab');
}

export async function closeTab(id, force = false) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return true;
  const t = state.tabs[i];
  if (!force && t.isDirty?.()) {
    const ok = await confirmDialog({
      title: 'Tutup tanpa menyimpan?',
      message: `Tab <b>${esc(t.title)}</b> punya perubahan yang belum disimpan.`,
      danger: true,
      confirmLabel: 'Buang & tutup',
    });
    if (!ok) return false;
  }
  t.onClose?.();
  t.panel.remove();
  state.tabs.splice(i, 1);
  if (state.activeTab === id) {
    const n = state.tabs[i] || state.tabs[i - 1];
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
  for (const t of state.tabs) {
    const el = h(
      'div',
      {
        class: 'tab' + (t.id === state.activeTab ? ' active' : '') + (t.isDirty?.() ? ' dirty' : '') + (t.fresh ? ' entering' : ''),
        title: t.tooltip || t.title,
      },
      h('span', { class: 't-ico', html: icon(t.icon || 'file') }),
      h('span', { class: 't-title', text: t.title }),
      h('button', { class: 't-close', title: 'Tutup (tengah-klik)', html: icon('x') }),
    );
    t.fresh = false;
    el.onclick = () => activateTab(t.id);
    el.onauxclick = (e) => {
      if (e.button === 1) closeTab(t.id);
    };
    el.querySelector('.t-close').onclick = (e) => {
      e.stopPropagation();
      closeTab(t.id);
    };
    el.oncontextmenu = (e) =>
      showMenu(e, [
        t.rename ? { label: 'Ganti nama…', icon: 'pencil', action: () => t.rename() } : null,
        { label: 'Tutup', icon: 'x', action: () => closeTab(t.id) },
        { label: 'Tutup tab lain', icon: 'copy-x', action: async () => { for (const x of state.tabs.filter((x) => x.id !== t.id)) await closeTab(x.id); } },
        { label: 'Tutup semua', icon: 'circle-x', action: async () => { for (const x of [...state.tabs]) await closeTab(x.id); } },
      ]);
    box.append(el);
  }
  $('#welcome').hidden = state.tabs.length > 0;
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
