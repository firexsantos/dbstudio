// Visual effects: pointer spotlight, ripples, parallax background, count-up, circular theme reveal.
import { $, local, api } from './core.js';
import { LOCALE } from './i18n.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
export const motionOK = () => !reduced.matches;

// Pointer spotlight on glass surfaces + background parallax (one rAF per frame).
let lit = null;
let last = null;
let scheduled = false;
addEventListener(
  'pointermove',
  (e) => {
    last = e;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const ev = last;
      if (!ev) return;
      const g = ev.target.closest?.('.glass');
      if (lit && lit !== g) lit.classList.remove('lit');
      if (g) {
        const r = g.getBoundingClientRect();
        g.style.setProperty('--mx', ev.clientX - r.left + 'px');
        g.style.setProperty('--my', ev.clientY - r.top + 'px');
        g.classList.add('lit');
      }
      lit = g;
      const dots = $('.dots');
      if (dots && motionOK()) {
        dots.style.setProperty('--px', (ev.clientX / innerWidth - 0.5).toFixed(3));
        dots.style.setProperty('--py', (ev.clientY / innerHeight - 0.5).toFixed(3));
      }
    });
  },
  { passive: true },
);

// Material-ish ripple on buttons.
addEventListener(
  'pointerdown',
  (e) => {
    const b = e.target.closest?.('.btn, .qa, .engine-pick button');
    if (!b || b.disabled || !motionOK()) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
    b.append(s);
    setTimeout(() => s.remove(), 700);
  },
  { passive: true },
);

// Animate a number from its current value to `to`.
export function countUp(el, to, ms = 700) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (!motionOK() || from === to) {
    el.textContent = Number(to).toLocaleString(LOCALE);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 4);
    el.textContent = Math.round(from + (to - from) * e).toLocaleString(LOCALE);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- theme
export function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
export function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
// Switch theme with a circle that grows from the clicked point (View Transitions API).
export function switchTheme(originEl) {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  local.set('dbs-theme', next);
  // Also kept server-side: the desktop app gets a new origin (port) per launch, which empties localStorage.
  api('POST', '/api/settings', { theme: next }).catch(() => {});
  if (!document.startViewTransition || !motionOK()) return applyTheme(next);
  const r = originEl?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth / 2;
  const y = r ? r.top + r.height / 2 : innerHeight / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const tr = document.startViewTransition(() => applyTheme(next));
  tr.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 650, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  });
}
// The server stamps the saved theme on <html>; fall back to this browser's own choice.
applyTheme(document.documentElement.dataset.theme || local.get('dbs-theme', null));

// Stagger children entrance by setting --i.
export function stagger(container) {
  [...container.children].forEach((c, i) => c.style.setProperty('--i', i));
  container.classList.add('stagger');
}

// Logo: database glyph inside an orbiting ring.
export const LOGO = `<svg class="logo-orb" viewBox="0 0 40 40" fill="none">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="40" y2="40"><stop stop-color="#8b5cff"/><stop offset=".55" stop-color="#36d6ff"/><stop offset="1" stop-color="#2dffb3"/></linearGradient></defs>
  <g class="lo-ring"><ellipse cx="20" cy="20" rx="18" ry="7" stroke="url(#lg)" stroke-width="1.4" opacity=".7" transform="rotate(-25 20 20)"/><circle cx="35.5" cy="13" r="1.8" fill="#36d6ff"/></g>
  <g class="lo-draw" stroke="url(#lg)" stroke-width="2" stroke-linecap="round">
    <ellipse cx="20" cy="12.5" rx="8" ry="3"/><path d="M12 12.5v15c0 1.7 3.6 3 8 3s8-1.3 8-3v-15"/><path d="M12 20c0 1.7 3.6 3 8 3s8-1.3 8-3"/>
  </g></svg>`;
