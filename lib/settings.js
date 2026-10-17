// App preferences (language, theme), stored in ~/.dbstudio/settings.json next to the connections.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// DBSTUDIO_DATA_DIR lets tests (and portable installs) keep their data elsewhere.
export const dataDir = () => process.env.DBSTUDIO_DATA_DIR || join(homedir(), '.dbstudio');

export const LANGUAGES = ['en', 'id'];
const THEMES = ['dark', 'light', null];
const DEFAULTS = { language: 'en', theme: null };

let cache = null; // { file, value }

export function get() {
  const file = join(dataDir(), 'settings.json');
  if (cache?.file === file) return cache.value;
  let value = { ...DEFAULTS };
  try {
    if (existsSync(file)) value = sanitize({ ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) });
  } catch {
    /* unreadable settings fall back to the defaults */
  }
  cache = { file, value };
  return value;
}

function sanitize(s) {
  return {
    ...s,
    language: LANGUAGES.includes(s.language) ? s.language : DEFAULTS.language,
    theme: THEMES.includes(s.theme) ? s.theme : null,
  };
}

export function set(patch = {}) {
  const next = { ...get() };
  if ('language' in patch) {
    if (!LANGUAGES.includes(patch.language)) throw new Error(`Unknown language: ${patch.language}`);
    next.language = patch.language;
  }
  if ('theme' in patch) {
    if (!THEMES.includes(patch.theme ?? null)) throw new Error(`Unknown theme: ${patch.theme}`);
    next.theme = patch.theme ?? null;
  }
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  cache = { file, value: next };
  return next;
}
