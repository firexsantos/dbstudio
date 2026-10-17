// "Tentang" tab: developer profile (Firman Santosa) and application info.
import { h, icon, esc, api, app, state } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { LOGO, motionOK } from './fx.js';

// Source: https://sifirman.com/tentang-saya
const PROFILE = {
  name: 'Firman Santosa',
  role: ['Web Developer', 'Educator', 'Tech Enthusiast'],
  location: 'Pekanbaru, Riau, Indonesia',
  bio: 'Berpengalaman dalam pengembangan aplikasi web modern, sistem informasi, dan passionate dalam mengajar teknologi.',
  photo: '/img/firman.webp',
  now: [
    { title: 'Chief Executive Officer', org: 'PT. Zakir Berkah Media — Raja Coding', icon: 'rocket' },
    { title: 'Dosen Ilmu Komputer', org: 'Universitas Rokania', icon: 'presentation' },
    { title: 'Wakil Direktur', org: 'CV. One Intelegensi Teknologi', icon: 'building-2' },
  ],
  contacts: [
    { label: 'Email', value: 'admin@sifirman.com', href: 'mailto:admin@sifirman.com', icon: 'mail', primary: true },
    { label: 'WhatsApp', value: '+62 812-1858-819', href: 'https://wa.me/628121858819', icon: 'message-circle' },
    { label: 'Website', value: 'sifirman.com', href: 'https://sifirman.com', icon: 'globe' },
  ],
  socials: [
    { label: 'GitHub', handle: 'firexsantos', href: 'https://github.com/firexsantos', icon: 'code-xml' },
    { label: 'LinkedIn', handle: 'firman-santosa', href: 'https://www.linkedin.com/in/firman-santosa/', icon: 'briefcase-business' },
    { label: 'Instagram', handle: '@firexserv', href: 'https://instagram.com/firexserv', icon: 'camera' },
    { label: 'X', handle: '@firexserv', href: 'https://x.com/firexserv', icon: 'at-sign' },
    { label: 'Facebook', handle: 'firexserv', href: 'https://facebook.com/firexserv', icon: 'users' },
  ],
};

const link = (href, inner, cls) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls, html: inner });

export async function openAbout() {
  const prev = findTab((t) => t.kind === 'about');
  if (prev) return activateTab(prev.id);
  const P = PROFILE;
  const yearsXp = new Date().getFullYear() - 2013;

  const hero = h(
    'section',
    { class: 'ab-hero' },
    h('div', { class: 'ab-photo' }, h('div', { class: 'ab-ring' }), h('img', { src: P.photo, alt: `Foto ${P.name}`, width: 640, height: 640 })),
    h(
      'div',
      { class: 'ab-intro' },
      h('div', { class: 'ab-eyebrow', html: `${icon('badge-check')} Pengembang DBStudio` }),
      h('h1', { class: 'ab-name', text: P.name }),
      h('div', { class: 'ab-role', html: P.role.map((r) => `<span>${esc(r)}</span>`).join('<i></i>') }),
      h('div', { class: 'ab-loc', html: `${icon('map-pin')} ${esc(P.location)}<span class="ab-dot"></span>${icon('calendar-range')} ${yearsXp}+ tahun berkarya` }),
      h('p', { class: 'ab-bio', text: P.bio }),
      h(
        'div',
        { class: 'ab-actions' },
        ...P.contacts.map((c) => link(c.href, `${icon(c.icon)}<span>${esc(c.primary ? c.label : c.value)}</span>`, `btn${c.primary ? ' primary' : ''}`)),
      ),
      h(
        'div',
        { class: 'ab-socials' },
        ...P.socials.map((s) => link(s.href, `${icon(s.icon)}<span class="ab-s-label">${esc(s.label)}</span><span class="ab-s-handle">${esc(s.handle)}</span>`, 'ab-social')),
      ),
    ),
  );

  const now = h(
    'section',
    { class: 'card ab-now' },
    h('div', { class: 'card-title', html: `${icon('sparkles')} Saat ini` }),
    h(
      'div',
      { class: 'ab-now-grid' },
      ...P.now.map((n, i) => h('div', { class: 'ab-now-item reveal', style: { '--i': i } }, h('div', { class: 'ab-now-ico', html: icon(n.icon) }), h('div', {}, h('div', { class: 'ab-now-title', text: n.title }), h('div', { class: 'ab-now-org', text: n.org })))),
    ),
  );

  const appInfo = h('div', { class: 'ab-app-meta faint', text: 'Memuat informasi versi…' });
  const appCard = h(
    'section',
    { class: 'card ab-app' },
    h('div', { class: 'ab-app-logo', html: LOGO }),
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'ab-app-name', html: 'DB<span class="grad-text">Studio</span>' }),
      h('div', { class: 'muted', text: 'Manajer database untuk MySQL/MariaDB, PostgreSQL & SQLite — SSH tunnel, ERD, salin antar server, schema sync.' }),
      appInfo,
      h('div', { class: 'ab-stack' }, ...['Node.js', 'Express', 'Electron', 'mysql2', 'node-postgres', 'node:sqlite', 'ssh2', 'CodeMirror'].map((s) => h('span', { class: 'chip', text: s }))),
    ),
    h(
      'div',
      { class: 'ab-copy', html: `© ${new Date().getFullYear()} ${esc(P.name)}<br><span class="faint">Lisensi MIT · </span>` },
      h('a', { href: 'https://github.com/firexsantos/dbstudio', target: '_blank', rel: 'noopener noreferrer', text: 'Kode sumber' }),
    ),
  );

  const page = h('div', { class: 'about' }, hero, now, appCard);
  const scroller = h('div', { class: 'scroll-pad ab-scroll' }, page);
  const panel = h('div', {}, scroller);
  const tab = { kind: 'about', icon: 'info', title: 'Tentang', panel };
  addTab(tab);

  // Reveal-on-scroll.
  const reveal = (el) => el.classList.add('in');
  if (motionOK() && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          reveal(e.target);
          io.unobserve(e.target);
        }
      },
      { root: scroller, threshold: 0.15 },
    );
    page.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  } else page.querySelectorAll('.reveal').forEach(reveal);

  try {
    const m = await api('GET', '/api/meta');
    appInfo.innerHTML = `Versi <b>${esc(m.version)}</b> · ${esc(m.runtime)} · ${esc(m.platform)}${state.conns.length ? ` · ${state.conns.length} koneksi tersimpan` : ''}`;
  } catch {
    appInfo.textContent = '';
  }
}

// Electron menu / deep link: http://…/#about
function hashRoute() {
  if (location.hash === '#about') {
    openAbout();
    history.replaceState(null, '', location.pathname);
  }
}
addEventListener('hashchange', hashRoute);
setTimeout(hashRoute, 0);

Object.assign(app, { openAbout });
