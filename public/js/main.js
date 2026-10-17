// DBStudio boot: wires every module, renders welcome + status bar, global shortcuts.
import { $, h, icon, esc, state, app, on, local, currentTab, clamp, TYPE_LABEL } from './core.js';
import './fx.js';
import { renderTabs, moveIndicator } from './tabs.js';
import { loadConns } from './conn.js';
import { initSidebar, connCard } from './sidebar.js';
import { restoreQueryTabs } from './query.js';
import './table.js';
import './designer.js';
import './erd.js';
import './copytool.js';
import './transfer.js';
import './compare.js';
import './servertool.js';
import './ops.js';
import './palette.js';
import './about.js';
import { initConnPanel } from './connmgr.js';
import './tools.js';
import './syncui.js';
import './genui.js';
import './findui.js';
import './backupui.js';
import './qbuilder.js';
import { maybeShowWhatsNew } from './whatsnew.js';
import './settings.js';
import { t, plural, translateDom } from './i18n.js';

// Three tilted elliptical orbits, each with a glowing satellite travelling along it.
function orbitsSvg() {
  const orbit = (rx, ry, tilt, color, dur, delay, width) => {
    const d = `M ${-rx} 0 a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
    return `<g transform="rotate(${tilt})">
      <path d="${d}" fill="none" stroke="url(#og-${color})" stroke-width="${width}" opacity=".75"/>
      <circle r="4.5" fill="${color === 'a' ? '#36d6ff' : color === 'b' ? '#8b5cff' : '#2dffb3'}" filter="url(#glow)">
        <animateMotion dur="${dur}s" begin="${delay}s" repeatCount="indefinite" path="${d}"/>
      </circle></g>`;
  };
  return `<svg viewBox="-200 -200 400 400" width="400" height="400" aria-hidden="true">
    <defs>
      <linearGradient id="og-a" x1="0" x2="1"><stop offset="0" stop-color="#36d6ff" stop-opacity="0"/><stop offset=".5" stop-color="#36d6ff"/><stop offset="1" stop-color="#36d6ff" stop-opacity=".1"/></linearGradient>
      <linearGradient id="og-b" x1="1" x2="0"><stop offset="0" stop-color="#8b5cff" stop-opacity="0"/><stop offset=".5" stop-color="#8b5cff"/><stop offset="1" stop-color="#8b5cff" stop-opacity=".1"/></linearGradient>
      <linearGradient id="og-c" x1="0" x2="1" y1="1" y2="0"><stop offset="0" stop-color="#2dffb3" stop-opacity="0"/><stop offset=".5" stop-color="#2dffb3"/><stop offset="1" stop-color="#2dffb3" stop-opacity=".1"/></linearGradient>
      <filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <g class="orbit-spin">${orbit(150, 44, -18, 'a', 7, 0, 1.6)}</g>
    <g class="orbit-spin r">${orbit(178, 58, 32, 'b', 11, -3, 1.3)}</g>
    <g class="orbit-spin">${orbit(120, 30, 76, 'c', 5.5, -1, 1.2)}</g>
  </svg>`;
}

function renderWelcome() {
  const w = $('#welcome');
  w.innerHTML = '';
  const qa = (ico, title, sub, fn) => h('button', { class: 'qa', onclick: fn }, h('div', { class: 'qa-ico', html: icon(ico) }), h('div', { class: 'qa-title', text: title }), h('div', { class: 'qa-sub', text: sub }));
  const recent = state.conns.slice(0, 4);
  const sparks = Array.from({ length: 14 }, (_, i) =>
    h('span', { class: 'spark', style: { left: `${10 + ((i * 53) % 80)}%`, top: `${15 + ((i * 37) % 70)}%`, animationDelay: `${(i * 0.37) % 4}s` } }),
  );
  w.append(
    h(
      'div',
      { class: 'welcome-inner' },
      h(
        'div',
        { class: 'hero' },
        h('div', { class: 'eyebrow', html: t('<span class="chip">NEW</span> SSH tunnel · ERD · cross-server copy · schema sync') }),
        h('h1', { html: t('Every database,<br><span class="grad-text">one studio.</span>') }),
        h('p', { text: t('MySQL/MariaDB, PostgreSQL and SQLite — manage connections, design tables & relations, copy data between servers and run queries in one interface.') }),
        h(
          'div',
          { class: 'qa-grid' },
          qa('plug-zap', t('New connection'), t('Direct or via SSH'), () => app.openConnDialog()),
          qa('sparkles', t('Try the demo'), t('Store database (SQLite)'), () => app.openDemo()),
          qa('square-terminal', t('New query'), t('SQL editor + autocomplete'), () => app.newQueryTab()),
          qa('workflow', 'ERD', t('Interactive relation diagram'), () => app.openTool('erd')),
          qa('copy-plus', t('Copy table'), t('To another DB / server / engine'), () => app.openTool('copy')),
          qa('command', t('Command palette'), 'Ctrl + K', () => app.openPalette()),
        ),
        recent.length
          ? h('div', { class: 'recent' }, h('div', { class: 'section-label', style: { marginBottom: '8px' }, text: t('Saved connections') }), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } }, ...recent.map((c) => connCard(c, { compact: true }))))
          : null,
        h('div', { class: 'welcome-credit' }, t('Developed by') + ' ', h('a', { text: 'Firman Santosa', onclick: () => app.openAbout() }), ' · ', h('a', { text: t('About the app'), onclick: () => app.openAbout() })),
      ),
      h(
        'div',
        { class: 'orb-stage' },
        ...sparks,
        h('div', { class: 'orbits', html: orbitsSvg() }),
        h('div', { class: 'orb' }, h('div', { class: 'core' })),
        h('div', { class: 'db-glyph', html: icon('database') }),
      ),
    ),
  );
  $('.db-glyph svg').style.cssText = 'width:56px;height:56px;stroke-width:1.5';
}

function renderStatus() {
  const a = state.active;
  const jobs = [...state.jobs.values()].filter((j) => j.status === 'running');
  const tab = currentTab();
  $('#statusbar').innerHTML = `
    <span class="sb-item"><span class="pulse ${a ? 'on' : ''}"></span>${a ? esc(a.conn.name) : t('Not connected')}</span>
    ${a ? `<span class="sb-item">${icon('database')} ${TYPE_LABEL[a.conn.type]} ${esc(String(a.version || '').split(/[ -]/)[0])}</span>` : ''}
    ${a && a.conn.type !== 'sqlite' ? `<span class="sb-item">${icon('folder')} ${esc(a.ns)}</span>` : ''}
    ${a?.conn.ssh?.enabled ? `<span class="sb-item">${icon('shield-check')} SSH ${esc(a.conn.ssh.host)}</span>` : ''}
    ${tab?.table ? `<span class="sb-item">${icon('table-2')} ${esc(tab.table)}</span>` : ''}
    <span class="spacer"></span>
    ${jobs.length ? `<span class="sb-item" style="color:var(--a2)">${icon('loader-circle', 'spin')} ${plural(jobs.length, '{n} job running', '{n} jobs running')} · ${Math.round((jobs[0].progress || 0) * 100)}%</span>` : ''}
    <span class="sb-item"><kbd>Ctrl</kbd><kbd>K</kbd> ${t('command palette')}</span>`;
}

// sidebar resizer
function initResizer() {
  const r = $('#resizer');
  const setW = (w) => document.documentElement.style.setProperty('--side-w', w + 'px');
  setW(local.get('dbs-side-w', 290));
  r.addEventListener('pointerdown', (e) => {
    r.setPointerCapture(e.pointerId);
    r.classList.add('dragging');
    const move = (ev) => {
      const w = clamp(ev.clientX - 78, 220, 560);
      setW(w);
      local.set('dbs-side-w', w);
      moveIndicator();
    };
    const up = () => {
      r.classList.remove('dragging');
      r.removeEventListener('pointermove', move);
      r.removeEventListener('pointerup', up);
      for (const tb of state.tabs) tb.cm?.refresh();
    };
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up);
  });
}

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p')) {
    e.preventDefault();
    if ($('.palette-back')) $('.palette-back').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    else app.openPalette();
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    currentTab()?.onSave?.();
  } else if (mod && e.key === ',') {
    e.preventDefault();
    app.openSettings();
  } else if (e.altKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    app.newQueryTab();
  }
});
addEventListener('beforeunload', (e) => {
  if (!window.__dbsReloading && state.tabs.some((x) => x.isDirty?.())) {
    e.preventDefault();
    e.returnValue = '';
  }
});

on('conns', renderWelcome);
for (const ev of ['connected', 'ns', 'tab', 'jobs']) on(ev, renderStatus);
setInterval(renderStatus, 1500);

(async function boot() {
  translateDom();
  initSidebar();
  initConnPanel();
  app.renderTools();
  initResizer();
  renderWelcome();
  renderStatus();
  try {
    await loadConns();
  } catch (e) {
    $('#welcome').prepend(h('div', { class: 'notice danger', style: { position: 'absolute', top: '20px', left: '20px', right: '20px' }, html: `${icon('triangle-alert')}<div>${esc(e.message)}</div>` }));
  }
  restoreQueryTabs();
  renderTabs();
  const last = local.get('dbs-last-conn', null);
  if (last && state.conns.some((c) => c.id === last)) app.connect(last, { silent: true });
  setTimeout(() => $('#app').classList.remove('intro'), 1400);
  setTimeout(maybeShowWhatsNew, 1600);
})();
