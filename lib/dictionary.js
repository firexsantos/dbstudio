// Data Dictionary: a self-contained HTML (or Markdown) document describing every table of a namespace.
import * as db from './drivers.js';
import { describeSchema } from './schema.js';
import { t, plural, num, locale, lang } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const anchor = (n) => 't-' + String(n).replace(/[^\w-]+/g, '_');
const ENGINE = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };

async function collect(conn, ns) {
  const models = await describeSchema(conn, ns);
  const counts = new Map();
  for (const m of models.filter((x) => x.kind === 'table')) {
    try {
      counts.set(m.name, Number((await db.raw(conn, `SELECT COUNT(*) FROM ${db.qualified(conn.type, ns, m.name)}`)).rows[0][0]));
    } catch {
      counts.set(m.name, null);
    }
  }
  const incoming = new Map();
  for (const m of models) for (const fk of m.foreignKeys) {
    if (!incoming.has(fk.refTable)) incoming.set(fk.refTable, []);
    incoming.get(fk.refTable).push({ from: m.name, columns: fk.columns, refColumns: fk.refColumns });
  }
  const info = await db.serverInfo(conn).catch(() => ({ version: '' }));
  return { models, counts, incoming, info };
}

export async function buildDictionary(conn, ns, { format = 'html', title } = {}) {
  const { models, counts, incoming, info } = await collect(conn, ns);
  const tables = models.filter((m) => m.kind === 'table');
  const views = models.filter((m) => m.kind === 'view');
  const docTitle = title || t('Data Dictionary — {name}', { name: conn.type === 'sqlite' ? conn.name : ns });
  const now = new Date().toLocaleString(locale(), { dateStyle: 'long', timeStyle: 'short' });
  const yes = t('yes');
  const no = t('no');
  const fkOf = (m, col) => m.foreignKeys.find((f) => f.columns.includes(col));

  if (format === 'md') {
    const L = [`# ${docTitle}`, '', `${ENGINE[conn.type]} ${String(info.version).split(' ')[0]} · ${plural(tables.length, '{n} table', '{n} tables')} · ${plural(views.length, '{n} view', '{n} views')} · ${t('generated {date}', { date: now })}`, ''];
    for (const m of [...tables, ...views]) {
      L.push(`## ${m.name}${m.kind === 'view' ? ' (view)' : ''}`, '');
      if (m.comment) L.push(m.comment, '');
      if (counts.has(m.name)) L.push(t('Rows: {n}', { n: num(counts.get(m.name)) }), '');
      L.push(`| ${t('Column')} | ${t('Type')} | Null | Default | ${t('Key')} | ${t('Description')} |`, '|---|---|---|---|---|---|');
      for (const c of m.columns) {
        const fk = fkOf(m, c.name);
        const key = [m.primaryKey.includes(c.name) ? 'PK' : '', fk ? `FK → ${fk.refTable}.${fk.refColumns[fk.columns.indexOf(c.name)]}` : ''].filter(Boolean).join(', ');
        L.push(`| \`${c.name}\` | ${c.type} | ${c.nullable ? yes : no} | ${c.default ?? ''} | ${key} | ${(c.comment || '').replace(/\|/g, '\\|')} |`);
      }
      L.push('');
    }
    return { content: L.join('\n'), mime: 'text/markdown', ext: 'md' };
  }

  const rowsTotal = [...counts.values()].reduce((s, n) => s + (n || 0), 0);
  const fkTotal = tables.reduce((s, m) => s + m.foreignKeys.length, 0);
  const section = (m) => {
    const inc = incoming.get(m.name) || [];
    return `<section class="tbl" id="${anchor(m.name)}">
  <header><h2>${esc(m.name)}</h2><span class="tag ${m.kind}">${m.kind === 'view' ? 'VIEW' : t('TABLE')}</span>${
    counts.has(m.name) ? `<span class="meta">${counts.get(m.name) == null ? '–' : plural(counts.get(m.name), '{n} row', '{n} rows')}</span>` : ''
  }${m.engine ? `<span class="meta">${esc(m.engine)}</span>` : ''}</header>
  ${m.comment ? `<p class="comment">${esc(m.comment)}</p>` : ''}
  <table><thead><tr><th>#</th><th>${t('Column')}</th><th>${t('Type')}</th><th>Null</th><th>Default</th><th>${t('Key')}</th><th>${t('Description')}</th></tr></thead><tbody>
  ${m.columns
    .map((c, i) => {
      const fk = fkOf(m, c.name);
      const keys = [
        m.primaryKey.includes(c.name) ? '<span class="k pk">PK</span>' : '',
        fk ? `<a class="k fk" href="#${anchor(fk.refTable)}">FK → ${esc(fk.refTable)}.${esc(fk.refColumns[fk.columns.indexOf(c.name)])}</a>` : '',
        c.autoIncrement ? '<span class="k ai">AUTO</span>' : '',
        m.indexes.some((x) => x.unique && x.columns.length === 1 && x.columns[0] === c.name) ? '<span class="k uq">UNIQUE</span>' : '',
      ].join(' ');
      return `<tr><td class="n">${i + 1}</td><td><code>${esc(c.name)}</code></td><td class="type">${esc(c.type)}</td><td>${c.nullable ? yes : `<b>${no}</b>`}</td><td class="type">${esc(
        c.generated ? '= ' + c.generated.expr : c.default ?? '',
      )}</td><td>${keys}</td><td>${esc(c.comment)}</td></tr>`;
    })
    .join('\n')}
  </tbody></table>
  ${
    m.indexes.length
      ? `<h3>${t('Indexes')}</h3><ul class="list">${m.indexes.map((x) => `<li><code>${esc(x.name)}</code> ${x.unique ? '<span class="k uq">UNIQUE</span>' : ''} (${esc(x.complex ? x.def || t('expression') : x.columns.join(', '))})</li>`).join('')}</ul>`
      : ''
  }
  ${
    m.foreignKeys.length
      ? `<h3>${t('Outgoing relations')}</h3><ul class="list">${m.foreignKeys
          .map((f) => `<li><code>${esc(f.columns.join(', '))}</code> → <a href="#${anchor(f.refTable)}">${esc(f.refTable)}</a> (<code>${esc(f.refColumns.join(', '))}</code>)${f.onDelete && f.onDelete !== 'NO ACTION' ? ` · ON DELETE ${esc(f.onDelete)}` : ''}</li>`)
          .join('')}</ul>`
      : ''
  }
  ${
    inc.length
      ? `<h3>${t('Referenced by')}</h3><ul class="list">${inc.map((f) => `<li><a href="#${anchor(f.from)}">${esc(f.from)}</a> (<code>${esc(f.columns.join(', '))}</code>)</li>`).join('')}</ul>`
      : ''
  }
  ${m.kind === 'view' && m.definition ? `<h3>${t('Definition')}</h3><pre>${esc(m.definition)}</pre>` : ''}
</section>`;
  };

  const html = `<!doctype html>
<html lang="${lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docTitle)}</title>
<style>
:root{--bg:#f6f7fb;--card:#fff;--line:#e3e6ef;--text:#14182e;--mute:#6b7190;--a1:#6b3dff;--a2:#0a9fd6;--a3:#0cb67f}
@media (prefers-color-scheme:dark){:root{--bg:#0a0c15;--card:#121628;--line:#262b45;--text:#e9ebf8;--mute:#8a90b4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
nav{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 16px;border-right:1px solid var(--line);background:var(--card)}
nav h1{font-size:15px;margin:0 0 4px}nav .sub{color:var(--mute);font-size:12px;margin-bottom:16px}
nav input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);margin-bottom:12px}
nav a{display:block;padding:4px 8px;border-radius:6px;color:var(--text);text-decoration:none;font:12.5px ui-monospace,Menlo,monospace}nav a:hover{background:var(--bg)}
main{padding:32px 40px;max-width:1200px}
.hero{padding:28px;border-radius:18px;color:#fff;background:linear-gradient(120deg,var(--a1),var(--a2) 60%,var(--a3));margin-bottom:24px}
.hero h1{margin:0 0 6px;font-size:28px}.hero p{margin:0;opacity:.9}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:-10px 0 28px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}.stat b{display:block;font-size:22px}.stat span{color:var(--mute);font-size:12px}
.tbl{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin-bottom:18px;scroll-margin-top:16px}
.tbl header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.tbl h2{margin:0;font:600 18px ui-monospace,Menlo,monospace}
.tag{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:10px;background:rgba(107,61,255,.12);color:var(--a1)}.tag.view{background:rgba(201,130,0,.14);color:#c98200}
.meta{color:var(--mute);font-size:12px}.comment{color:var(--mute);margin:8px 0 0}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mute)}td.n{color:var(--mute);width:32px}.type{font:12px ui-monospace,Menlo,monospace;color:var(--mute)}
code{font:12.5px ui-monospace,Menlo,monospace}
.k{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:8px;margin:1px 2px 1px 0;text-decoration:none}
.pk{background:rgba(201,130,0,.15);color:#c98200}.fk{background:rgba(10,159,214,.14);color:var(--a2)}.ai{background:rgba(12,182,127,.14);color:var(--a3)}.uq{background:rgba(107,61,255,.12);color:var(--a1)}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--mute);margin:18px 0 6px}.list{margin:0;padding-left:18px}.list li{margin:3px 0}
pre{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;font-size:12px}
footer{color:var(--mute);font-size:12px;margin:30px 0 10px}
@media print{nav{display:none}.wrap{display:block}.tbl{break-inside:avoid}}
@media (max-width:900px){.wrap{display:block}nav{position:static;height:auto}main{padding:20px}.stats{grid-template-columns:1fr 1fr}}
</style></head><body><div class="wrap">
<nav><h1>${esc(docTitle)}</h1><div class="sub">${esc(ENGINE[conn.type])}</div>
<input id="q" placeholder="${esc(t('Search tables…'))}" oninput="for(const a of document.querySelectorAll('nav a'))a.style.display=a.textContent.toLowerCase().includes(this.value.toLowerCase())?'':'none'">
${[...tables, ...views].map((m) => `<a href="#${anchor(m.name)}">${esc(m.name)}${m.kind === 'view' ? ' ◦' : ''}</a>`).join('')}
</nav>
<main>
<div class="hero"><h1>${esc(docTitle)}</h1><p>${esc(ENGINE[conn.type])} ${esc(String(info.version).split(' ')[0])}${conn.type !== 'sqlite' ? ' · ' + esc(ns) : ''} · ${esc(t('generated {date}', { date: now }))}</p></div>
<div class="stats"><div class="stat"><b>${tables.length}</b><span>${t('Tables')}</span></div><div class="stat"><b>${views.length}</b><span>${t('Views')}</span></div><div class="stat"><b>${num(rowsTotal)}</b><span>${t('Total rows')}</span></div><div class="stat"><b>${fkTotal}</b><span>${t('Relations')}</span></div></div>
${[...tables, ...views].map(section).join('\n')}
<footer>${t('Made with DBStudio')}</footer>
</main></div></body></html>`;
  return { content: html, mime: 'text/html', ext: 'html' };
}
