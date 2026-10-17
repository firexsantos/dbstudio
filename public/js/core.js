/* global CodeMirror */
// Shared helpers, state and UI primitives for every DBStudio module.
import { ICONS } from '/vendor/icons.js';
import { t, LOCALE } from './i18n.js';

// ---------------------------------------------------------------- DOM
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** h('div', {class:'x', onclick: fn}, child, 'text', [more]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      // Object.assign() silently drops CSS custom properties (--x); setProperty handles both.
      for (const [p, val] of Object.entries(v)) {
        if (val == null) continue;
        if (p.startsWith('--')) el.style.setProperty(p, String(val));
        else el.style[p] = val;
      }
    }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const frag = (html) => document.createRange().createContextualFragment(html);

// ---------------------------------------------------------------- icons (lucide)
const pascal = (name) => name.replace(/(^|-)(\w)/g, (_m, _d, c) => c.toUpperCase());
const iconCache = new Map();
export function icon(name, cls = '') {
  const key = name + '|' + cls;
  if (iconCache.has(key)) return iconCache.get(key);
  const node = ICONS[pascal(name)] || ICONS.Circle;
  const inner = node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  const svg = `<svg class="i ${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  iconCache.set(key, svg);
  return svg;
}
export const iconEl = (name, cls) => frag(icon(name, cls)).firstElementChild;

// ---------------------------------------------------------------- misc helpers
export const local = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable — app still works */
    }
  },
};
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const fmtNum = (n) => (n == null || Number.isNaN(Number(n)) ? '–' : Number(n).toLocaleString(LOCALE));
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t('{n}s ago', { n: s });
  if (s < 3600) return t('{n}m ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n}h ago', { n: Math.round(s / 3600) });
  return new Date(ts).toLocaleDateString(LOCALE);
}
export function debounce(fn, ms) {
  let timer;
  return (...a) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- dialect helpers
export const TYPE_LABEL = { mysql: 'MySQL', postgres: 'PostgreSQL', sqlite: 'SQLite' };
export const ENGINE_SHORT = { mysql: 'My', postgres: 'Pg', sqlite: 'Lt' };
export const DEFAULT_PORT = { mysql: 3306, postgres: 5432 };
export const CM_MODE = { mysql: 'text/x-mariadb', postgres: 'text/x-pgsql', sqlite: 'text/x-sqlite' };
export const COLORS = ['#8b5cff', '#36d6ff', '#2dffb3', '#ffbe55', '#ff5a7a', '#ff4fd8', '#8a90b4'];
export const engineBadge = (type, sm = false) => `<span class="engine ${type}${sm ? ' sm' : ''}">${ENGINE_SHORT[type] || '?'}</span>`;
export const nsLabel = (type) => (type === 'postgres' ? 'Schema' : 'Database');

export function quoteIdent(name, type) {
  return type === 'mysql' ? '`' + String(name).replaceAll('`', '``') + '`' : '"' + String(name).replaceAll('"', '""') + '"';
}
export function qualify(type, ns, name) {
  return type === 'sqlite' || !ns ? quoteIdent(name, type) : quoteIdent(ns, type) + '.' + quoteIdent(name, type);
}
export const DEFAULT = Symbol('DEFAULT'); // not-yet-filled cell of a new row
export function valStr(v) {
  if (v === DEFAULT) return '';
  if (v == null) return 'NULL';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
export function sqlLiteral(v) {
  if (v == null || v === DEFAULT) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + valStr(v).replaceAll("'", "''") + "'";
}

// Split SQL into statement ranges, ignoring ';' inside quotes and comments.
export function statementRanges(text) {
  const out = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nx = text[i + 1];
    if (quote) {
      if (ch === '\\' && quote !== '`') i++;
      else if (ch === quote) {
        if (nx === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '-' && nx === '-') {
      const e = text.indexOf('\n', i);
      i = e === -1 ? text.length : e;
      continue;
    }
    if (ch === '/' && nx === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? text.length : e + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === ';') {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  out.push({ start, end: text.length });
  return out.filter((r) => text.slice(r.start, r.end).trim());
}

// ---------------------------------------------------------------- state & events
export const state = {
  conns: [],
  // Every open connection is a workspace with its own explorer, database/schema and tabs:
  // { wid, conn, namespaces, label, ns, version, flavor, tables, columns, objects, activeTab }
  workspaces: [],
  ws: null, // wid of the workspace on screen
  tabs: [],
  activeTab: null,
  seq: 0,
  jobs: new Map(),
};
// `active`, `tables`, `columns` and `objects` always describe the workspace on screen, so the many modules that read
// them keep working unchanged while each workspace keeps its own copy.
const EMPTY_OBJECTS = { routines: [], triggers: [], events: [] };
export const wsById = (wid) => state.workspaces.find((w) => w.wid === wid) || null;
Object.defineProperties(state, {
  active: { get: () => wsById(state.ws), enumerable: true },
  tables: { get: () => wsById(state.ws)?.tables || [], set: (v) => { const w = wsById(state.ws); if (w) w.tables = v; } },
  columns: { get: () => wsById(state.ws)?.columns || {}, set: (v) => { const w = wsById(state.ws); if (w) w.columns = v; } },
  objects: { get: () => wsById(state.ws)?.objects || EMPTY_OBJECTS, set: (v) => { const w = wsById(state.ws); if (w) w.objects = v; } },
});
export const app = {}; // cross-module function registry
const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));
export const currentTab = () => state.tabs.find((x) => x.id === state.activeTab);
/** Tabs that belong to the workspace on screen. */
export const wsTabs = () => state.tabs.filter((x) => x.ws === state.ws);
export const connById = (id) => state.conns.find((c) => c.id === id);

// ---------------------------------------------------------------- API
export async function api(method, url, body, { text = false } = {}) {
  const headers = { 'X-DBStudio': '1' };
  let payload;
  if (body !== undefined) {
    if (text) {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new Error(t('The DBStudio server cannot be reached. Is `npm start` still running?'));
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = { error: res.statusText };
  }
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code || null });
  return data;
}
export const qs = (o) =>
  '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = 'info', { title, timeout } = {}) {
  const dur = timeout ?? (kind === 'err' ? 7000 : 3200);
  const ico = kind === 'ok' ? 'check' : kind === 'err' ? 'triangle-alert' : 'sparkles';
  const el = h(
    'div',
    { class: `toast ${kind}`, style: { '--dur': dur + 'ms' } },
    h('div', { class: 't-ico', html: icon(ico) }),
    h('div', { class: 't-body' }, title ? h('div', { class: 't-title', text: title }) : null, h('div', { text: msg })),
    h('div', { class: 't-bar' }),
  );
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  };
  el.addEventListener('click', close);
  $('#toasts').append(el);
  setTimeout(close, dur);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('Copied to clipboard'), 'ok', { timeout: 1600 });
  } catch {
    toast(t('Could not copy to clipboard'), 'err');
  }
}

// ---------------------------------------------------------------- context menu
export function showMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  hideMenu();
  const m = h('div', { id: 'ctx-menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      m.append(h('hr'));
      continue;
    }
    if (it.label && it.header) {
      m.append(h('div', { class: 'm-label', text: it.label }));
      continue;
    }
    const b = h('button', { class: it.danger ? 'danger' : '', html: (it.icon ? icon(it.icon) : '<svg class="i"></svg>') + `<span>${esc(it.label)}</span>` });
    b.disabled = Boolean(it.disabled);
    b.onclick = () => {
      hideMenu();
      it.action();
    };
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  const x = Math.min(e.clientX, innerWidth - r.width - 8);
  const y = Math.min(e.clientY, innerHeight - r.height - 8);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  m.style.setProperty('--ox', e.clientX - x + 'px');
  m.style.setProperty('--oy', e.clientY - y + 'px');
}
export const hideMenu = () => $('#ctx-menu')?.remove();
addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctx-menu')) hideMenu();
});
addEventListener('blur', hideMenu);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
});

// ---------------------------------------------------------------- modal
/**
 * modal({ title, sub, icon, danger, body, actions:[{label, kind, icon, onClick, close}], size, onClose })
 * onClick may return false (keep open) or a promise.
 */
export function modal({ title, sub, icon: ico = 'sparkles', danger = false, body, actions = [], size = '', onClose, dismissable = true }) {
  const back = h('div', { class: 'modal-back' });
  const bodyEl = body instanceof Node ? body : h('div', { html: body || '' });
  const foot = h('div', { class: 'modal-foot' });
  const box = h(
    'div',
    { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'modal-head' },
      h('div', { class: `mh-ico${danger ? ' danger' : ''}`, html: icon(ico) }),
      h('div', { class: 'grow' }, h('div', { class: 'mh-title', text: title }), sub ? h('div', { class: 'mh-sub', text: sub }) : null),
      dismissable ? h('button', { class: 'btn ghost icon sm', html: icon('x'), onclick: () => close(), title: t('Close') }) : null,
    ),
    h('div', { class: 'modal-body' }, bodyEl),
    foot,
  );
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    back.classList.add('closing');
    setTimeout(() => back.remove(), 220);
    removeEventListener('keydown', onKey, true);
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable && back === $$('.modal-back').at(-1)) {
      e.stopPropagation();
      close();
    }
  };
  addEventListener('keydown', onKey, true);
  for (const a of actions) {
    if (a === 'spacer') {
      foot.append(h('span', { class: 'spacer' }));
      continue;
    }
    if (a instanceof Node) {
      foot.append(a);
      continue;
    }
    const b = h('button', { class: `btn ${a.kind || ''}`, html: (a.icon ? icon(a.icon) : '') + `<span>${esc(a.label)}</span>` });
    b.onclick = async () => {
      if (!a.onClick) return close();
      b.classList.add('loading');
      b.disabled = true;
      try {
        const r = await a.onClick({ close, button: b, body: bodyEl });
        if (r !== false) close(r);
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        b.classList.remove('loading');
        b.disabled = false;
      }
    };
    if (a.id) b.id = a.id;
    foot.append(b);
  }
  if (!actions.length) foot.remove();
  back.addEventListener('mousedown', (e) => {
    if (e.target === back && dismissable) close();
  });
  back.append(box);
  document.body.append(back);
  setTimeout(() => bodyEl.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea')?.focus(), 60);
  return { el: box, body: bodyEl, close, foot };
}

export function confirmDialog({ title, message, danger = false, confirmLabel = t('Continue'), icon: ico }) {
  return new Promise((resolve) => {
    modal({
      title,
      icon: ico || (danger ? 'triangle-alert' : 'circle-help'),
      danger,
      body: h('div', { class: 'muted', html: message }),
      actions: ['spacer', { label: t('Cancel') }, { label: confirmLabel, kind: danger ? 'danger solid' : 'primary', onClick: () => true }],
      onClose: (r) => resolve(r === true),
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', icon: ico = 'pencil', confirmLabel = t('Save') }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder });
    const m = modal({
      title,
      icon: ico,
      body: h('div', { class: 'field' }, h('label', { text: label }), input),
      actions: ['spacer', { label: t('Cancel') }, { label: confirmLabel, kind: 'primary', onClick: () => input.value.trim() || false }],
      onClose: (r) => resolve(typeof r === 'string' ? r : null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) m.close(input.value.trim());
    });
    setTimeout(() => input.select(), 80);
  });
}

// ---------------------------------------------------------------- editors
export function cmTheme() {
  return 'dbstudio';
}
export function createEditor(parent, { value = '', type = state.active?.conn.type || 'mysql', readOnly = false, lineWrapping = false, extraKeys = {}, hint = false } = {}) {
  const cm = CodeMirror(parent, {
    value,
    mode: CM_MODE[type] || 'text/x-sql',
    theme: cmTheme(),
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: !readOnly,
    styleActiveLine: !readOnly,
    readOnly,
    lineWrapping,
    tabSize: 2,
    indentWithTabs: false,
    extraKeys,
    hintOptions: hint ? { tables: state.columns, completeSingle: false } : undefined,
  });
  setTimeout(() => cm.refresh(), 30);
  return cm;
}

/**
 * Show generated SQL, let the user edit it, then run it on connId/ns.
 * Resolves true when executed successfully.
 */
export function sqlPreview({ title, sub, statements, connId, ns, type, warnings = [], confirmLabel = t('Run'), danger = false, icon: ico = 'file-code-2' }) {
  return new Promise((resolve) => {
    const original = statements.join('\n\n');
    const box = h('div', { class: 'code-box', style: { height: '320px', flex: 'none', margin: 0 } });
    const body = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      ...warnings.map((w) => h('div', { class: 'notice warn', html: icon('triangle-alert') + `<div>${esc(w)}</div>` })),
      statements.length ? box : h('div', { class: 'notice info', html: icon('info') + `<div>${t('No changes — the SQL is empty.')}</div>` }),
      h('div', { class: 'faint', style: { fontSize: '11.5px' }, html: `${icon('pencil')} ${t('You can edit the SQL before running it.')}` }),
    );
    let cm;
    const m = modal({
      title,
      sub,
      icon: ico,
      danger,
      size: 'wide',
      body,
      actions: [
        h('button', { class: 'btn ghost sm', html: icon('copy') + `<span>${t('Copy')}</span>`, onclick: () => copyText(cm?.getValue() || original) }),
        'spacer',
        { label: t('Cancel') },
        {
          label: confirmLabel,
          kind: danger ? 'danger solid' : 'primary',
          icon: 'play',
          onClick: async () => {
            const text = cm ? cm.getValue() : original;
            if (!text.trim()) return true;
            const stmts = text === original ? statements : [text];
            await api('POST', `/api/c/${connId}/script`, { ns, statements: stmts });
            return 'ok';
          },
        },
      ],
      onClose: (r) => resolve(r === 'ok'),
    });
    if (statements.length) cm = createEditor(box, { value: original, type, lineWrapping: true });
    void m;
  });
}

// ---------------------------------------------------------------- jobs
export function watchJob(job, onUpdate) {
  state.jobs.set(job.id, job);
  emit('jobs');
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const j = await api('GET', `/api/jobs/${job.id}`);
        state.jobs.set(j.id, j);
        emit('jobs');
        onUpdate?.(j);
        if (j.status === 'running') setTimeout(tick, 350);
        else resolve(j);
      } catch {
        setTimeout(tick, 1000);
      }
    };
    tick();
  });
}
export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}
export function downloadText(name, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- form bits
export function checkbox(label, checked = false, onchange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  if (onchange) input.addEventListener('change', () => onchange(input.checked));
  const el = h('label', { class: 'check' }, input, h('span', { class: 'box', html: icon('check') }), label ? h('span', { text: label }) : null);
  el.input = input;
  return el;
}
export function toggle(label, checked = false, onchange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  if (onchange) input.addEventListener('change', () => onchange(input.checked));
  const el = h('label', { class: 'switch' }, input, h('span', { class: 'track' }), label ? h('span', { text: label }) : null);
  el.input = input;
  return el;
}
/** Segmented control with a sliding thumb. options: [{value, label, icon}] */
export function segmented(options, value, onchange) {
  const el = h('div', { class: 'seg' });
  const thumb = h('span', { class: 'seg-thumb' });
  el.append(thumb);
  const move = () => {
    const b = el.querySelector('button.active');
    if (!b) return;
    thumb.style.width = b.offsetWidth + 'px';
    thumb.style.transform = `translateX(${b.offsetLeft - 3}px)`;
  };
  for (const o of options) {
    const b = h('button', { type: 'button', html: (o.icon ? icon(o.icon) : '') + esc(o.label) });
    if (o.value === value) b.classList.add('active');
    b.onclick = () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      el.value = o.value;
      move();
      onchange?.(o.value);
    };
    el.append(b);
  }
  el.value = value;
  el.set = (v) => {
    const i = options.findIndex((o) => o.value === v);
    el.querySelectorAll('button').forEach((x, k) => x.classList.toggle('active', k === i));
    el.value = v;
    move();
  };
  requestAnimationFrame(() => requestAnimationFrame(move));
  new ResizeObserver(move).observe(el);
  return el;
}
export function select(options, value, attrs = {}) {
  const el = h('select', { class: 'select', ...attrs });
  for (const o of options) {
    const opt = typeof o === 'object' ? o : { value: o, label: o };
    const op = h('option', { value: opt.value }, opt.label);
    if (String(opt.value) === String(value)) op.selected = true;
    el.append(op);
  }
  return el;
}
export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('div', { class: 'hint', html: hint }) : null);
}
