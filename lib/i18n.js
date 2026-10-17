// Server-side translations: same English-keyed dictionary as the UI, language from settings.json.
// Call t() when a message is produced (never at module load) so a language switch applies at once.
import ID from '../public/js/locales/id.js';
import * as settings from './settings.js';

const DICTS = { id: ID };

export const lang = () => settings.get().language;
export const locale = () => (lang() === 'id' ? 'id-ID' : 'en-US');
export const num = (n) => (n == null || Number.isNaN(Number(n)) ? '–' : Number(n).toLocaleString(locale()));

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** t('Copied {n} rows', { n }) — the English text is the key; Indonesian comes from locales/id.js. */
export function t(s, vars) {
  const out = DICTS[lang()]?.[s] ?? s;
  return vars ? fill(out, vars) : out;
}

/** plural(n, '{n} row', '{n} rows') — {n} is filled with the locale-formatted number. */
export const plural = (n, one, other, vars) => t(Number(n) === 1 ? one : other, { ...vars, n: num(n) });
