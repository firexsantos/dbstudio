// Backup & restore timeline + data dictionary export.
import { h, icon, esc, api, qs, state, app, toast, modal, watchJob, download, downloadText, confirmDialog, field, select, segmented, fmtBytes, timeAgo, nsLabel } from './core.js';
import { addTab, activateTab, findTab } from './tabs.js';
import { progressRing } from './copytool.js';
import { t, plural, LOCALE } from './i18n.js';

export function openBackup() {
  const a = state.active;
  if (!a) return;
  const prev = findTab((x) => x.kind === 'backup' && x.connId === a.conn.id);
  if (prev) return activateTab(prev.id);
  const conn = a.conn;
  const panel = h('div');
  const nsSel = conn.type === 'sqlite' ? null : select(a.namespaces.map((n) => ({ value: n, label: n })), a.ns);
  const note = h('input', { class: 'input', placeholder: t('Note (optional), e.g. "before v2 migration"') });
  const go = h('button', { class: 'btn primary', html: icon('archive') + `<span>${t('Back up now')}</span>` });
  const ring = progressRing(70);
  const run = h('div', { class: 'row', hidden: true, style: { marginTop: '12px', gap: '14px' } }, ring, h('div', { class: 'faint run-phase' }));
  const timeline = h('div', { class: 'bk-timeline' });
  panel.append(
    h(
      'div',
      { class: 'scroll-pad' },
      h('div', { class: 'page-head' }, h('div', { class: 'ph-ico', html: icon('archive-restore') }), h('div', {}, h('h2', { text: t('Backup & restore') }), h('p', { class: 'faint', text: t('{name} — backups are stored compressed on this computer (~/.dbstudio/backups).', { name: conn.name }) }))),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-title', html: icon('archive') + t('Create backup') }),
        h('div', { class: 'form-grid' }, nsSel ? field(nsLabel(conn.type), nsSel) : null, h('div', { class: nsSel ? '' : 'full' }, field(t('Note'), note))),
        h('div', { class: 'row', style: { marginTop: '12px' } }, h('div', { class: 'faint', html: `${icon('info')} ${t('Structure, data, indexes, relations & views — in a single SQL file.')}` }), h('span', { class: 'spacer' }), go),
        run,
      ),
      h('div', { class: 'section-label', style: { margin: '22px 4px 10px' }, text: t('Backup history') }),
      timeline,
    ),
  );
  const tab = { kind: 'backup', icon: 'archive-restore', title: t('Backup: {name}', { name: conn.name }), panel, connId: conn.id };
  addTab(tab);

  async function load() {
    timeline.innerHTML = '<div class="skeleton" style="height:80px"></div>';
    const list = await api('GET', `/api/c/${conn.id}/backups`).catch((e) => (toast(e.message, 'err'), []));
    timeline.innerHTML = '';
    if (!list.length) return timeline.append(h('div', { class: 'empty', html: `${icon('archive')}<div>${t('No backups for this connection yet.')}</div>` }));
    list.forEach((b, i) => {
      const d = new Date(b.createdAt);
      timeline.append(
        h(
          'div',
          { class: 'bk-item', style: { '--i': i } },
          h('div', { class: 'bk-dot' }),
          h(
            'div',
            { class: 'bk-card' },
            h(
              'div',
              { class: 'row wrap' },
              h('b', { text: d.toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }) }),
              h('span', { class: 'faint', text: timeAgo(d.getTime()) }),
              conn.type !== 'sqlite' ? h('span', { class: 'chip', html: `${icon('folder')} ${esc(b.ns)}` }) : null,
              h('span', { class: 'chip', text: `${plural(b.tables, '{n} table', '{n} tables')} · ${plural(b.rows, '{n} row', '{n} rows')}` }),
              h('span', { class: 'chip', text: fmtBytes(b.size) }),
              h('span', { class: 'spacer' }),
              h('button', { class: 'btn sm', title: t('Download .sql'), html: icon('download'), onclick: () => dl(b) }),
              h('button', { class: 'btn sm', html: icon('history') + `<span>${t('Restore')}</span>`, onclick: () => restore(b) }),
              h('button', { class: 'btn sm ghost danger', title: t('Delete backup'), html: icon('trash-2'), onclick: () => del(b) }),
            ),
            b.note ? h('div', { class: 'bk-note', text: b.note }) : null,
          ),
        ),
      );
    });
  }

  go.onclick = async () => {
    go.disabled = true;
    run.hidden = false;
    try {
      const job = await api('POST', `/api/c/${conn.id}/backups`, { ns: nsSel?.value || a.ns, note: note.value });
      const j = await watchJob(job, (x) => {
        ring.set(x.progress);
        run.querySelector('.run-phase').textContent = x.phase;
      });
      if (j.status !== 'done') throw new Error(j.error || t('Cancelled'));
      toast(`${plural(j.result.tables, '{n} table', '{n} tables')} · ${plural(j.result.rows, '{n} row', '{n} rows')}`, 'ok', { title: t('Backup saved') });
      note.value = '';
      load();
    } catch (e) {
      toast(e.message, 'err', { title: t('Backup failed') });
    } finally {
      go.disabled = false;
      run.hidden = true;
    }
  };

  async function dl(b) {
    const j = await watchJob(await api('POST', `/api/c/${conn.id}/backups/${encodeURIComponent(b.id)}/download`));
    if (j.download) download(j.download);
  }
  async function del(b) {
    if (!(await confirmDialog({ title: t('Delete backup?'), message: t('Backup <b>{date}</b> will be permanently deleted.', { date: esc(new Date(b.createdAt).toLocaleString(LOCALE)) }), danger: true, confirmLabel: t('Delete') }))) return;
    await api('DELETE', `/api/c/${conn.id}/backups/${encodeURIComponent(b.id)}`);
    load();
  }
  async function restore(b) {
    const target = conn.type === 'sqlite' ? null : select(state.active?.conn.id === conn.id ? state.active.namespaces.map((n) => ({ value: n, label: n })) : [{ value: b.ns, label: b.ns }], b.ns);
    modal({
      title: t('Restore backup'),
      sub: new Date(b.createdAt).toLocaleString(LOCALE),
      icon: 'history',
      danger: true,
      body: h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('div', { class: 'notice warn', html: `${icon('triangle-alert')}<div>${t('Tables in the backup will be <b>dropped and recreated</b> with the backup contents. Other tables are left untouched.')}</div>` }),
        target ? field(t('Target {ns}', { ns: nsLabel(conn.type) }), target) : null,
      ),
      actions: [
        'spacer',
        { label: t('Cancel') },
        {
          label: t('Restore'),
          kind: 'danger solid',
          icon: 'history',
          onClick: async () => {
            setTimeout(async () => {
              run.hidden = false;
              try {
                const job = await api('POST', `/api/c/${conn.id}/backups/${encodeURIComponent(b.id)}/restore`, { ns: target?.value || b.ns });
                const j = await watchJob(job, (x) => {
                  ring.set(x.progress);
                  run.querySelector('.run-phase').textContent = x.phase;
                });
                if (j.status !== 'done') throw new Error(j.error || t('Cancelled'));
                toast(plural(j.result.ok, '{n} statement executed', '{n} statements executed'), 'ok', { title: t('Restore complete') });
                if (state.active?.conn.id === conn.id) app.loadTree();
              } catch (e) {
                toast(e.message, 'err', { title: t('Restore failed') });
              } finally {
                run.hidden = true;
              }
            });
            return true;
          },
        },
      ],
    });
  }
  load();
}

export function openDictionary() {
  const a = state.active;
  if (!a) return;
  let format = 'html';
  modal({
    title: t('Data dictionary'),
    sub: `${a.conn.name}${a.conn.type !== 'sqlite' ? ' / ' + a.ns : ''}`,
    icon: 'book-open-text',
    body: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'muted', text: t('A complete document of every table & view: columns, types, nulls, defaults, keys, indexes, outgoing & incoming relations, and row counts.') }),
      field(
        t('Format'),
        segmented(
          [
            { value: 'html', label: t('HTML (print/PDF ready)'), icon: 'globe' },
            { value: 'md', label: 'Markdown', icon: 'file-text' },
          ],
          format,
          (v) => (format = v),
        ),
      ),
    ),
    actions: [
      'spacer',
      { label: t('Cancel') },
      {
        label: t('Create document'),
        kind: 'primary',
        icon: 'download',
        onClick: async () => {
          const r = await api('GET', `/api/c/${a.conn.id}/dictionary${qs({ ns: a.ns, format })}`);
          const base = `data-dictionary-${(a.conn.type === 'sqlite' ? a.conn.name : a.ns).replace(/[^\w-]+/g, '_')}`;
          downloadText(`${base}.${r.ext}`, r.content, r.mime);
          toast(t('Document created'), 'ok');
        },
      },
    ],
  });
}

Object.assign(app, { openBackup, openDictionary });
