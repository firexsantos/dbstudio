// Settings: interface language and appearance. Saved server-side in ~/.dbstudio/settings.json.
import { h, icon, api, app, state, toast, modal, copyText, confirmDialog, local } from './core.js';
import { t, LANG, LANGUAGES } from './i18n.js';

// An older server process (started before an update) has no /api/settings yet.
const saveError = (e) =>
  e.message === 'Not Found'
    ? toast(t('The running DBStudio server is older than this page. Restart it (npm start) and reload.'), 'err', { title: t('Server needs a restart') })
    : toast(e.message, 'err');
import { currentTheme, applyTheme, motionOK } from './fx.js';

const THEMES = [
  { id: null, label: () => t('System'), hint: () => t('Follow the operating system') },
  { id: 'dark', label: () => t('Dark'), hint: () => t('Nebula glass at night') },
  { id: 'light', label: () => t('Light'), hint: () => t('Bright frosted glass') },
];

// A tiny window mock-up drawn in the theme it represents.
const themePreview = (id) =>
  h(
    'div',
    { class: `st-mock ${id || 'system'}` },
    h('i', { class: 'm-rail' }),
    h('div', { class: 'm-main' }, h('i', { class: 'm-bar' }), h('i', { class: 'm-line w1' }), h('i', { class: 'm-line w2' }), h('i', { class: 'm-line w3' })),
  );

export async function openSettings() {
  let saved = { language: LANG, theme: null, dataDir: '' };
  try {
    saved = await api('GET', '/api/settings');
  } catch {
    /* older server: show what the page knows */
  }

  // ---- language
  const langBox = h('div', { class: 'st-langs', role: 'radiogroup', 'aria-label': t('Interface language') });
  for (const [i, l] of LANGUAGES.entries()) {
    const card = h(
      'button',
      { class: 'st-lang' + (l.code === LANG ? ' on' : ''), role: 'radio', 'aria-checked': String(l.code === LANG), style: { '--i': i } },
      h('span', { class: 'st-glyph', text: l.code.toUpperCase() }),
      h('span', { class: 'st-lang-text' }, h('b', { text: l.native }), h('span', { class: 'faint', text: l.code === 'en' ? t('English') : t('Indonesian') }), h('span', { class: 'st-sample', text: `“${l.sample}”` })),
      h('span', { class: 'st-check', html: icon('check') }),
    );
    card.onclick = () => switchLanguage(l.code, card);
    langBox.append(card);
  }

  // ---- theme
  const themeBox = h('div', { class: 'st-themes', role: 'radiogroup', 'aria-label': t('Theme') });
  const paintThemes = (sel) => {
    for (const el of themeBox.children) {
      const on = (el.dataset.theme || null) === sel;
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', String(on));
    }
  };
  for (const [i, th] of THEMES.entries()) {
    const card = h('button', { class: 'st-theme', role: 'radio', 'data-theme': th.id || '', style: { '--i': i } }, themePreview(th.id), h('b', { text: th.label() }), h('span', { class: 'faint', text: th.hint() }));
    card.onclick = async () => {
      paintThemes(th.id);
      local.set('dbs-theme', th.id);
      const go = () => applyTheme(th.id);
      if (document.startViewTransition && motionOK()) document.startViewTransition(go);
      else go();
      try {
        await api('POST', '/api/settings', { theme: th.id });
      } catch (e) {
        saveError(e);
      }
    };
    themeBox.append(card);
  }
  paintThemes(saved.theme ?? null);

  const section = (ico, title, sub, body) =>
    h('section', { class: 'st-sec' }, h('div', { class: 'st-sec-head' }, h('span', { class: 'st-sec-ico', html: icon(ico) }), h('div', {}, h('b', { text: title }), h('div', { class: 'faint', text: sub }))), body);

  const dir = h('code', { class: 'st-path', text: saved.dataDir || '~/.dbstudio' });
  const body = h(
    'div',
    { class: 'st-body' },
    section('languages', t('Language'), t('Used for menus, dialogs and messages. English is the default.'), langBox),
    section('palette', t('Appearance'), t('Pick a theme, or let DBStudio follow your system.'), themeBox),
    section(
      'folder-cog',
      t('Data folder'),
      t('Connections, settings and backups are stored here, on this computer only.'),
      h('div', { class: 'st-row' }, dir, h('button', { class: 'btn sm ghost', html: icon('copy') + `<span>${t('Copy')}</span>`, onclick: () => copyText(dir.textContent).then(() => toast(t('Path copied'), 'ok')) })),
    ),
  );
  modal({ title: t('Settings'), sub: t('Preferences for this computer'), icon: 'settings', size: 'wide st-modal', body, actions: ['spacer', { label: t('Done'), kind: 'primary' }] });
}

async function switchLanguage(code, card) {
  if (code === LANG) return;
  const dirty = state.tabs.filter((x) => x.isDirty?.()).length;
  if (
    dirty &&
    !(await confirmDialog({
      title: t('Reload to switch language?'),
      message: t('DBStudio reloads to apply the language. {n} tab(s) with unsaved changes will lose them.', { n: dirty }),
      danger: true,
      confirmLabel: t('Reload'),
    }))
  )
    return;
  card.classList.add('picking');
  try {
    await api('POST', '/api/settings', { language: code });
  } catch (e) {
    card.classList.remove('picking');
    return saveError(e);
  }
  // A short "page turn" before the reload, so the switch reads as intentional rather than a crash.
  const target = LANGUAGES.find((l) => l.code === code);
  const veil = h('div', { class: 'st-veil' }, h('div', { class: 'st-veil-glyph', text: code.toUpperCase() }), h('div', { class: 'st-veil-text', text: target.native }));
  document.body.append(veil);
  window.__dbsReloading = true;
  setTimeout(() => location.reload(), motionOK() ? 750 : 0);
}

Object.assign(app, { openSettings });
