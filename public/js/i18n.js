// UI translations. English is the source language and the key; Indonesian lives in locales/id.js.
// The server stamps the chosen language on <html lang>, so it is known before any module renders,
// which is what lets module-level constants call t() too. Changing it reloads the page.
import ID from './locales/id.js';

export const LANG = document.documentElement.lang === 'id' ? 'id' : 'en';
export const LOCALE = LANG === 'id' ? 'id-ID' : 'en-US';
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', sample: 'Hello — ready to query.' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', sample: 'Halo — siap menjalankan query.' },
];
const DICT = LANG === 'id' ? ID : null;

// Keys missing from the active dictionary, for spotting untranslated text (inspect window.__i18nMissing).
const missing = new Set();
if (DICT) window.__i18nMissing = missing;

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** t('Delete {n} rows?', { n }) */
export function t(s, vars) {
  let out = s;
  if (DICT) {
    if (s in DICT) out = DICT[s];
    else if (!missing.has(s)) {
      missing.add(s);
      console.debug('[i18n] missing translation:', s);
    }
  }
  return vars ? fill(out, vars) : out;
}

const num = (n) => Number(n).toLocaleString(LOCALE);
/** plural(n, '{n} row', '{n} rows') — {n} is filled with the locale-formatted number. */
export const plural = (n, one, other, vars) => t(Number(n) === 1 ? one : other, { ...vars, n: num(n) });

// Static markup in index.html is written in English; translate its text and tooltip attributes once.
export function translateDom(root = document.body) {
  if (!DICT) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.nodeValue.trim();
    if (s && s in DICT) n.nodeValue = n.nodeValue.replace(s, DICT[s]);
  }
  for (const el of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v && v in DICT) el.setAttribute(a, DICT[v]);
    }
  }
}
