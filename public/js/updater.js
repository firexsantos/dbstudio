// Updates: on every start DBStudio asks GitHub for a newer release. If there is one, a clear dialog explains what is
// new and upgrades in one click (download → verify checksum → install → restart). "Later" only closes it for this
// session — the next start shows it again until DBStudio is up to date.
import { $, h, icon, esc, api, state, app, emit, on, toast, modal, confirmDialog, fmtBytes, watchJob } from './core.js';
import { t, LOCALE } from './i18n.js';
import { progressRing } from './copytool.js';

state.update = null; // last check result

/** Small, safe Markdown → HTML for release notes (headings, lists, bold, italics, code, links). */
export function notesHtml(md) {
  const body = String(md || '').split(/^###\s+Downloads\b/m)[0]; // the download table is for the web page
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) flush();
    else if ((m = /^#{1,4}\s+(.*)$/.exec(line))) {
      flush();
      out.push(`<h4>${inline(m[1])}</h4>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) (list ||= []).push(m[1]);
    else if (list && /^\s{2,}\S/.test(raw)) list[list.length - 1] += ' ' + line.trim(); // wrapped bullet
    else {
      flush();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  return out.join('');
}

/** Ask the server (which asks GitHub). `auto` = the silent start-up check. */
export async function checkForUpdates({ auto = false, force = false } = {}) {
  let info;
  try {
    info = await api('GET', `/api/update/check${force ? '?force=1' : ''}`);
  } catch (e) {
    if (!auto) toast(e.message, 'err', { title: t('Update check failed') });
    return null;
  }
  state.update = info;
  emit('update');
  if (!info.available) {
    if (!auto) toast(t('You have the latest version ({v}).', { v: info.current }), 'ok', { title: t('DBStudio is up to date') });
    return info;
  }
  if (auto) await quietMoment();
  openUpdate(info);
  return info;
}

// Don't stack on top of another dialog (e.g. "What's new"): wait until the screen is free.
async function quietMoment() {
  for (let i = 0; i < 60 && $('.modal-back'); i++) await new Promise((r) => setTimeout(r, 500));
}

export function openUpdate(info = state.update) {
  if (!info?.available) return;
  if ($('.upd-modal')) return;
  const date = info.publishedAt ? new Date(info.publishedAt).toLocaleDateString(LOCALE, { dateStyle: 'long' }) : '';
  const hero = h(
    'div',
    { class: 'upd-hero' },
    h('div', { class: 'upd-ver old' }, h('span', { text: t('Installed') }), h('b', { text: `v${info.current}` })),
    h('div', { class: 'upd-beam' }, h('i'), h('i'), h('i')),
    h('div', { class: 'upd-ver new' }, h('span', { text: t('New') }), h('b', { text: `v${info.latest}` })),
  );
  const meta = h(
    'div',
    { class: 'upd-meta faint' },
    [date && h('span', { html: `${icon('calendar')} ${esc(date)}` }), info.asset && h('span', { html: `${icon('hard-drive-download')} ${esc(info.asset.name)} · ${fmtBytes(info.asset.size)}` })].filter(Boolean),
  );
  const notes = h('div', { class: 'upd-notes', html: notesHtml(info.notes) || `<p class="faint">${esc(t('No release notes.'))}</p>` });
  const ring = progressRing(64);
  const phase = h('div', { class: 'upd-phase' });
  const hint = h('div', { class: 'faint upd-hint' });
  const work = h('div', { class: 'upd-work', hidden: true }, ring, h('div', { class: 'grow' }, phase, hint));
  const errBox = h('div', { class: 'notice danger', hidden: true });
  const source = info.kind
    ? null
    : h(
        'div',
        { class: 'notice' },
        h('span', { html: icon('terminal') }),
        h('div', { html: t('You are running DBStudio from source. Update with <code>git pull && npm install</code>, or download the installer from the release page.') }),
      );

  const body = h('div', { class: 'upd-body' }, hero, meta, h('div', { class: 'section-label', text: t("What's new") }), notes, source, work, errBox);
  let busy = false;
  const upgradeLabel = info.ready ? t('Install & restart') : t('Upgrade now');
  const m = modal({
    title: t('A new version of DBStudio is available'),
    sub: t('DBStudio {latest} is ready — you have {current}.', { latest: info.latest, current: info.current }),
    icon: 'rocket',
    size: 'wide upd-modal',
    body,
    actions: [
      { label: t('Release page'), icon: 'external-link', kind: 'ghost', onClick: () => (window.open(info.url, '_blank', 'noopener'), false) },
      'spacer',
      { label: t('Later'), onClick: () => !busy },
      info.canInstall ? { label: upgradeLabel, icon: 'download', kind: 'primary', id: 'upd-go', onClick: () => (upgrade(), false) } : null,
    ].filter(Boolean),
  });

  async function upgrade() {
    if (busy) return;
    const dirty = state.tabs.filter((x) => x.isDirty?.()).length;
    if (
      dirty &&
      !(await confirmDialog({
        title: t('Unsaved changes'),
        message: t('DBStudio restarts after the update. Changes in {n} tab(s) that are not saved will be lost.', { n: dirty }),
        danger: true,
        confirmLabel: t('Update anyway'),
      }))
    )
      return;
    busy = true;
    errBox.hidden = true;
    work.hidden = false;
    const go = $('#upd-go');
    if (go) go.disabled = true;
    try {
      if (!state.update?.ready) {
        phase.textContent = t('Starting download…');
        hint.textContent = t('You can keep working — the download runs in the background.');
        const job = await api('POST', '/api/jobs/update/download');
        const j = await watchJob(job, (x) => {
          ring.set(x.progress || 0);
          phase.textContent = x.phase || '';
        });
        if (j.status !== 'done') throw new Error(j.error || t('Cancelled'));
        state.update = { ...state.update, ready: true };
      }
      ring.set(1);
      phase.textContent = t('Installing…');
      hint.textContent = info.kind === 'deb' ? t('Your system may ask for your password to install the package.') : '';
      window.__dbsReloading = true; // no "leave page?" prompt while the app restarts
      const r = await api('POST', '/api/update/install');
      if (r.next === 'restart') {
        phase.textContent = t('Restarting DBStudio…');
        hint.textContent = t('The new version opens in a moment.');
        body.classList.add('upd-done');
      } else if (r.next === 'installer') {
        phase.textContent = t('The installer is starting…');
        hint.textContent = t('DBStudio closes now so the installer can replace it.');
        body.classList.add('upd-done');
      } else {
        window.__dbsReloading = false;
        phase.textContent = t('The system installer was opened.');
        hint.textContent = t('Finish the installation there, then open DBStudio again.');
        busy = false;
      }
    } catch (e) {
      window.__dbsReloading = false;
      busy = false;
      work.hidden = true;
      errBox.hidden = false;
      errBox.innerHTML = `${icon('triangle-alert')}<div>${esc(e.message)}</div>`;
      if (go) go.disabled = false;
    }
  }
  return m;
}

// A quiet reminder that stays visible after "Later": a glowing dot on the settings gear.
function paintBadge() {
  $('#btn-settings')?.classList.toggle('has-update', Boolean(state.update?.available));
}
on('update', paintBadge);

Object.assign(app, { checkForUpdates, openUpdate });
