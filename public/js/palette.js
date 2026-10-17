// Command palette (Ctrl+K / Ctrl+P): fuzzy search over actions, connections, tables and history.
import { $, h, icon, esc, state, app, local, TYPE_LABEL } from './core.js';
import { switchTheme } from './fx.js';
import { connSub } from './conn.js';

function score(text, q) {
  if (!q) return { s: 1, marks: [] };
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return { s: 1000 - direct - t.length * 0.1, marks: [...Array(q.length).keys()].map((k) => direct + k) };
  let i = 0;
  let s = 0;
  let last = -2;
  const marks = [];
  for (const ch of q) {
    const j = t.indexOf(ch, i);
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

function items() {
  const a = state.active;
  const list = [
    { group: 'Aksi', title: 'Koneksi baru', icon: 'plug-zap', run: () => app.openConnDialog() },
    { group: 'Aksi', title: 'Query baru', sub: 'Ctrl+Enter untuk menjalankan', icon: 'square-terminal', run: () => app.newQueryTab() },
    a && { group: 'Aksi', title: 'Tabel baru', sub: 'Table designer', icon: 'table-properties', run: () => app.openDesigner(null) },
    a && { group: 'Aksi', title: 'Lihat ERD', sub: 'Diagram relasi tabel', icon: 'workflow', run: () => app.openTool('erd') },
    { group: 'Aksi', title: 'Salin tabel ke database / server lain', icon: 'copy-plus', run: () => app.openTool('copy') },
    a && { group: 'Aksi', title: 'Export / Import', sub: 'SQL dump, CSV, JSON', icon: 'arrow-down-up', run: () => app.openTool('transfer') },
    { group: 'Aksi', title: 'Bandingkan skema', sub: 'Schema compare & sync', icon: 'git-compare', run: () => app.openTool('compare') },
    a && { group: 'Aksi', title: 'Info server', sub: 'Proses, variabel, status, pengguna', icon: 'server', run: () => app.openTool('server') },
    a && a.conn.type !== 'sqlite' && { group: 'Aksi', title: `${a.conn.type === 'postgres' ? 'Schema' : 'Database'} baru`, icon: 'folder-plus', run: () => app.createNamespace() },
    { group: 'Aksi', title: 'Ganti tema terang / gelap', icon: 'sun-moon', run: () => switchTheme($('#btn-theme')) },
    { group: 'Aksi', title: 'Buka database demo', icon: 'sparkles', run: () => app.openDemo() },
    { group: 'Aksi', title: 'Tentang DBStudio & pengembang', sub: 'Firman Santosa', icon: 'info', run: () => app.openAbout() },
    a && { group: 'Aksi', title: 'Putuskan koneksi', icon: 'unplug', run: () => app.disconnect() },
    ...state.conns.map((c) => ({ group: 'Koneksi', title: c.name, sub: `${TYPE_LABEL[c.type]} · ${connSub(c)}`, icon: 'database', run: () => app.connect(c.id) })),
    ...(a ? state.tables.map((t) => ({ group: t.kind === 'view' ? 'View' : 'Tabel', title: t.name, sub: `${a.ns} · Enter buka data`, icon: t.kind === 'view' ? 'eye' : 'table-2', run: () => app.openTableTab(t.name) })) : []),
    ...local
      .get('dbs-history', [])
      .slice(0, 12)
      .map((x) => ({ group: 'Riwayat', title: x.sql.replace(/\s+/g, ' ').slice(0, 90), sub: x.conn, icon: 'history', run: () => app.newQueryTab(x.sql) })),
  ];
  return list.filter(Boolean);
}

export function openPalette() {
  if ($('.palette-back')) return;
  const input = h('input', { placeholder: 'Ketik perintah, tabel, atau koneksi…', spellcheck: 'false' });
  const list = h('div', { class: 'p-list' });
  const hl = h('div', { class: 'p-hl' });
  const pal = h(
    'div',
    { class: 'palette glass' },
    h('div', { class: 'p-input', html: icon('command') }, input, h('kbd', { text: 'Esc' })),
    list,
    h('div', { class: 'p-foot', html: '<span><kbd>↑</kbd> <kbd>↓</kbd> pilih</span><span><kbd>Enter</kbd> jalankan</span><span><kbd>Ctrl</kbd> + <kbd>K</kbd> buka/tutup</span>' }),
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
      .map((it) => ({ it, m: score(`${it.title} ${it.sub || ''}`, q) }))
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
    if (!results.length) list.append(h('div', { class: 'empty', text: 'Tidak ada yang cocok' }));
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
