// Command palette (Ctrl+K / Ctrl+P): fuzzy search over actions, connections, tables and history.
import { $, h, icon, esc, state, app, local, TYPE_LABEL } from './core.js';
import { switchTheme } from './fx.js';
import { connSub } from './conn.js';
import { t } from './i18n.js';

function score(text, q) {
  if (!q) return { s: 1, marks: [] };
  const low = text.toLowerCase();
  const direct = low.indexOf(q);
  if (direct >= 0) return { s: 1000 - direct - low.length * 0.1, marks: [...Array(q.length).keys()].map((k) => direct + k) };
  let i = 0;
  let s = 0;
  let last = -2;
  const marks = [];
  for (const ch of q) {
    const j = low.indexOf(ch, i);
    if (j < 0) return null;
    s += j === last + 1 ? 6 : 1;
    marks.push(j);
    last = j;
    i = j + 1;
  }
  return { s, marks };
}
function highlight(text, marks) {
  const set = new Set(marks);
  return [...text].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join('');
}

// `kw` holds search words in both languages, so a command is found by its English or Indonesian name
// whichever language the interface is in.
function items() {
  const a = state.active;
  const act = t('Actions');
  const list = [
    { group: act, title: t('New connection'), icon: 'plug-zap', kw: 'new connection koneksi baru', run: () => app.openConnDialog() },
    { group: act, title: t('New query'), sub: t('Ctrl+Enter to run'), icon: 'square-terminal', kw: 'new query baru sql editor', run: () => app.newQueryTab() },
    a && { group: act, title: t('New table'), sub: 'Table designer', icon: 'table-properties', kw: 'new table tabel baru create buat', run: () => app.openDesigner(null) },
    a && { group: act, title: t('View ERD'), sub: t('Table relation diagram'), icon: 'workflow', kw: 'erd diagram relation relasi lihat', run: () => app.openTool('erd') },
    { group: act, title: t('Copy table to another database / server'), icon: 'copy-plus', kw: 'copy table salin tabel database server lain', run: () => app.openTool('copy') },
    { group: act, title: t('Data sync'), sub: t('Compare & match table contents'), icon: 'arrow-left-right', kw: 'data sync sinkronisasi bandingkan samakan', run: () => app.openTool('datasync') },
    a && { group: act, title: t('Query Builder'), sub: t('Build queries visually'), icon: 'blocks', kw: 'query builder visual susun', run: () => app.openTool('qb') },
    a && { group: act, title: t('Test data generator'), icon: 'wand-sparkles', kw: 'test data generator generate data uji isi', run: () => app.openTool('datagen') },
    a && { group: act, title: t('Search database'), sub: t('Find values across all tables'), icon: 'search-code', kw: 'search find database cari temukan nilai', run: () => app.openTool('finder') },
    a && { group: act, title: t('Data dictionary'), sub: t('HTML / Markdown document'), icon: 'book-open-text', kw: 'data dictionary dokumen document kamus', run: () => app.openTool('dictionary') },
    a && { group: act, title: t('Backup & restore'), icon: 'archive-restore', kw: 'backup restore cadangan pulihkan', run: () => app.openTool('backup') },
    { group: act, title: t('Import connections'), sub: 'DBStudio, Navicat .ncx, DBeaver', icon: 'download', kw: 'import connections koneksi', run: () => app.openImportDialog() },
    { group: act, title: t('Export connections'), sub: t('Can be encrypted with a passphrase'), icon: 'upload', kw: 'export connections koneksi enkripsi encrypt', run: () => app.openExportDialog() },
    { group: act, title: t("What's new"), icon: 'gift', kw: "what's new apa yang baru changelog rilis release", run: () => app.openWhatsNew() },
    { group: act, title: t('Settings'), sub: 'Ctrl+,', icon: 'settings', kw: 'settings pengaturan preferences preferensi language bahasa theme tema data folder', run: () => app.openSettings() },
    a && { group: act, title: t('Export / Import'), sub: t('SQL dump, CSV, JSON'), icon: 'arrow-down-up', kw: 'export import ekspor impor dump csv json', run: () => app.openTool('transfer') },
    { group: act, title: t('Schema compare'), sub: 'Schema compare & sync', icon: 'git-compare', kw: 'schema compare sync bandingkan skema sinkronkan', run: () => app.openTool('compare') },
    a && { group: act, title: t('Server info'), sub: t('Processes, variables, status, users'), icon: 'server', kw: 'server info proses process variabel variables pengguna users', run: () => app.openTool('server') },
    a && a.conn.type !== 'sqlite' && { group: act, title: a.conn.type === 'postgres' ? t('New schema') : t('New database'), icon: 'folder-plus', kw: 'new schema database baru create buat', run: () => app.createNamespace() },
    { group: act, title: t('Toggle light / dark theme'), icon: 'sun-moon', kw: 'theme light dark ganti tema terang gelap', run: () => switchTheme($('#btn-theme')) },
    { group: act, title: t('Open demo database'), icon: 'sparkles', kw: 'open demo database buka', run: () => app.openDemo() },
    { group: act, title: t('About DBStudio & the developer'), sub: 'Firman Santosa', icon: 'info', kw: 'about tentang developer pengembang', run: () => app.openAbout() },
    a && { group: act, title: t('Disconnect'), icon: 'unplug', kw: 'disconnect putuskan koneksi', run: () => app.disconnect() },
    ...state.conns.map((c) => ({ group: t('Connections'), title: c.name, sub: `${TYPE_LABEL[c.type]} · ${connSub(c)}`, icon: 'database', kw: 'connection koneksi', run: () => app.connect(c.id) })),
    ...(a ? state.tables.map((tb) => ({ group: tb.kind === 'view' ? t('View') : t('Table'), title: tb.name, sub: t('{ns} · Enter to open data', { ns: a.ns }), icon: tb.kind === 'view' ? 'eye' : 'table-2', run: () => app.openTableTab(tb.name) })) : []),
    ...local
      .get('dbs-history', [])
      .slice(0, 12)
      .map((x) => ({ group: t('History'), title: x.sql.replace(/\s+/g, ' ').slice(0, 90), sub: x.conn, icon: 'history', run: () => app.newQueryTab(x.sql) })),
  ];
  return list.filter(Boolean);
}

export function openPalette() {
  if ($('.palette-back')) return;
  const input = h('input', { placeholder: t('Type a command, table or connection…'), spellcheck: 'false' });
  const list = h('div', { class: 'p-list' });
  const hl = h('div', { class: 'p-hl' });
  const pal = h(
    'div',
    { class: 'palette glass' },
    h('div', { class: 'p-input', html: icon('command') }, input, h('kbd', { text: 'Esc' })),
    list,
    h('div', { class: 'p-foot', html: `<span><kbd>↑</kbd> <kbd>↓</kbd> ${t('select')}</span><span><kbd>Enter</kbd> ${t('run')}</span><span><kbd>Ctrl</kbd> + <kbd>K</kbd> ${t('open/close')}</span>` }),
  );
  const back = h('div', { class: 'palette-back' }, pal);
  let results = [];
  let sel = 0;
  const all = items();
  const close = () => {
    back.style.animation = 'fade-out .18s var(--ease) both';
    setTimeout(() => back.remove(), 170);
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    results = all
      .map((it) => ({ it, m: score(`${it.title} ${it.sub || ''} ${it.kw || ''}`, q) }))
      .filter((x) => x.m)
      .sort((x, y) => y.m.s - x.m.s)
      .slice(0, 40);
    sel = 0;
    list.innerHTML = '';
    list.append(hl);
    let group = null;
    results.forEach(({ it, m }, i) => {
      if (!q && it.group !== group) {
        group = it.group;
        list.append(h('div', { class: 'p-group', text: group }));
      }
      const titleMarks = m.marks.filter((k) => k < it.title.length);
      const el = h('div', { class: 'p-item', 'data-i': i, html: `<div class="p-ico">${icon(it.icon)}</div><div class="p-text"><div>${highlight(it.title, titleMarks)}</div>${it.sub ? `<div class="p-sub">${esc(it.sub)}</div>` : ''}</div>${q ? `<span class="chip">${esc(it.group)}</span>` : ''}` });
      el.onmousemove = () => select(i);
      el.onclick = () => runSel(i);
      list.append(el);
    });
    if (!results.length) list.append(h('div', { class: 'empty', text: t('No matches') }));
    requestAnimationFrame(() => select(0, true));
  };
  const select = (i, instant = false) => {
    sel = Math.max(0, Math.min(results.length - 1, i));
    const el = list.querySelector(`.p-item[data-i="${sel}"]`);
    list.querySelectorAll('.p-item').forEach((x) => x.classList.toggle('sel', x === el));
    if (!el) return (hl.style.opacity = 0);
    hl.style.opacity = 1;
    if (instant) hl.style.transition = 'none';
    hl.style.transform = `translateY(${el.offsetTop}px)`;
    hl.style.height = el.offsetHeight + 'px';
    if (instant) requestAnimationFrame(() => (hl.style.transition = ''));
    el.scrollIntoView({ block: 'nearest' });
  };
  const runSel = (i) => {
    const r = results[i];
    if (!r) return;
    close();
    setTimeout(() => r.it.run(), 60);
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), select(sel + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), select(sel - 1));
    else if (e.key === 'Enter') (e.preventDefault(), runSel(sel));
    else if (e.key === 'Escape') (e.preventDefault(), close());
  });
  back.addEventListener('mousedown', (e) => e.target === back && close());
  document.body.append(back);
  render();
  input.focus();
}

Object.assign(app, { openPalette });
