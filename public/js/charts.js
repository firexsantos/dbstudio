// Charts for query results: bar, line, area, donut, scatter — animated SVG with tooltips and PNG/SVG export.
import { h, icon, esc, fmtNum, segmented, downloadText, valStr } from './core.js';
import { motionOK } from './fx.js';
import { t, LOCALE } from './i18n.js';

const PALETTE = ['#8b5cff', '#36d6ff', '#2dffb3', '#ffbe55', '#ff5a7a', '#ff4fd8', '#7fd4ff', '#c9a2ff', '#5be3a8', '#ff9d6e'];
const TYPES = [
  { value: 'bar', label: t('Bar'), icon: 'chart-column' },
  { value: 'line', label: t('Line'), icon: 'chart-line' },
  { value: 'area', label: t('Area'), icon: 'chart-area' },
  { value: 'donut', label: t('Donut'), icon: 'chart-pie' },
  { value: 'scatter', label: t('Scatter'), icon: 'chart-scatter' },
];
const MAX_POINTS = 120;

const num = (v) => (v == null || v === '' ? NaN : Number(v));
function numericColumns(columns, rows) {
  return columns.map((_, i) => {
    let n = 0;
    let ok = 0;
    for (const r of rows.slice(0, 300)) {
      if (r[i] == null || r[i] === '') continue;
      n++;
      if (Number.isFinite(num(r[i]))) ok++;
    }
    return n > 0 && ok / n >= 0.8;
  });
}
function niceTicks(min, max, count = 5) {
  if (min === max) {
    min = min === 0 ? 0 : min * 0.9;
    max = max === 0 ? 1 : max * 1.1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}
const short = (n) => {
  const a = Math.abs(n);
  const one = (x) => x.toLocaleString(LOCALE, { maximumFractionDigits: 1 });
  if (a >= 1e9) return t('{n}B', { n: one(n / 1e9) });
  if (a >= 1e6) return t('{n}M', { n: one(n / 1e6) });
  if (a >= 1e3) return t('{n}K', { n: one(n / 1e3) });
  return fmtNum(+n.toFixed(2));
};

/** Mount a chart builder into `box` for a result set. */
export function mountChart(box, { columns, rows, title = t('chart') }) {
  box.innerHTML = '';
  const isNum = numericColumns(columns, rows);
  const numCols = columns.map((c, i) => i).filter((i) => isNum[i]);
  if (!numCols.length) {
    box.append(h('div', { class: 'empty', html: `${icon('chart-no-axes-column')}<div>${t('No numeric columns to chart. Try a query with an aggregate, e.g. <span class="mono">COUNT(*)</span> or <span class="mono">SUM(price)</span>.')}</div>` }));
    return;
  }
  const xDefault = columns.findIndex((_, i) => !isNum[i]);
  const st = { type: 'bar', x: xDefault >= 0 ? xDefault : -1, ys: new Set([numCols.find((i) => i !== xDefault) ?? numCols[0]]), sort: '' };
  const xSel = h('select', { class: 'select sm' }, h('option', { value: -1 }, t('(row number)')), ...columns.map((c, i) => h('option', { value: i, selected: i === st.x }, c)));
  xSel.onchange = () => ((st.x = Number(xSel.value)), draw());
  const yBox = h('div', { class: 'chart-ys' });
  const renderYs = () => {
    yBox.innerHTML = '';
    numCols.forEach((i, k) => {
      const on = st.ys.has(i);
      const b = h('button', { class: 'chip chart-y' + (on ? ' on' : ''), style: { '--c': PALETTE[k % PALETTE.length] }, html: `<i></i>${esc(columns[i])}` });
      b.onclick = () => {
        if (on && st.ys.size === 1) return;
        on ? st.ys.delete(i) : st.ys.add(i);
        renderYs();
        draw();
      };
      yBox.append(b);
    });
  };
  const sortSel = h('select', { class: 'select sm' }, h('option', { value: '' }, t('Original order')), h('option', { value: 'desc' }, t('Largest first')), h('option', { value: 'asc' }, t('Smallest first')), h('option', { value: 'x' }, t('X axis')));
  sortSel.onchange = () => ((st.sort = sortSel.value), draw());
  const typeSeg = segmented(TYPES, st.type, (v) => ((st.type = v), draw()));
  const exportBtn = h('button', { class: 'btn sm', html: icon('image-down') + `<span>${t('Export')}</span>` });
  const stage = h('div', { class: 'chart-stage' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const note = h('div', { class: 'faint chart-note' });
  box.append(
    h('div', { class: 'chart-bar' }, typeSeg, h('span', { class: 'faint', text: 'X' }), xSel, h('span', { class: 'faint', text: 'Y' }), yBox, h('span', { class: 'spacer' }), sortSel, exportBtn),
    h('div', { class: 'chart-wrap' }, stage, tip),
    note,
  );
  renderYs();
  exportBtn.onclick = (e) => exportMenu(e, stage, title);

  function data() {
    let pts = rows.map((r, i) => ({ x: st.x < 0 ? i + 1 : r[st.x], ys: [...st.ys].map((k) => num(r[k])) }));
    if (st.sort === 'desc' || st.sort === 'asc') pts.sort((a, b) => (st.sort === 'desc' ? -1 : 1) * ((a.ys[0] || 0) - (b.ys[0] || 0)));
    if (st.sort === 'x') pts.sort((a, b) => valStr(a.x).localeCompare(valStr(b.x), LOCALE, { numeric: true }));
    const total = pts.length;
    if (pts.length > MAX_POINTS) pts = pts.slice(0, MAX_POINTS);
    note.textContent = total > MAX_POINTS ? t('Showing {shown} of {total} rows — use an aggregate or LIMIT to summarize.', { shown: fmtNum(MAX_POINTS), total: fmtNum(total) }) : '';
    return pts;
  }

  function draw() {
    const pts = data();
    const series = [...st.ys].map((k, si) => ({ name: columns[k], color: PALETTE[numCols.indexOf(k) % PALETTE.length], idx: si }));
    const W = Math.max(480, stage.clientWidth || 900);
    const H = 380;
    const anim = motionOK();
    stage.innerHTML = '';
    let svg;
    if (st.type === 'donut') svg = donut(pts, series[0], W, H, anim);
    else svg = cartesian(pts, series, W, H, anim, st.type, st.x >= 0 && isNum[st.x]);
    stage.append(svg);
    // legend
    const legend = h('div', { class: 'chart-legend' });
    if (st.type === 'donut') {
      const tot = pts.reduce((s, p) => s + (Math.max(0, p.ys[0]) || 0), 0) || 1;
      pts.slice(0, 12).forEach((p, i) => legend.append(h('span', { html: `<i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(valStr(p.x))} <b>${((Math.max(0, p.ys[0]) / tot) * 100).toFixed(1)}%</b>` })));
    } else series.forEach((s) => legend.append(h('span', { html: `<i style="background:${s.color}"></i>${esc(s.name)}` })));
    stage.append(legend);
    // tooltips
    stage.querySelectorAll('[data-tip]').forEach((el) => {
      el.addEventListener('pointerenter', () => {
        tip.hidden = false;
        tip.innerHTML = el.dataset.tip;
        el.classList.add('hot');
      });
      el.addEventListener('pointermove', (e) => {
        const r = stage.parentElement.getBoundingClientRect();
        tip.style.left = Math.min(r.width - 200, e.clientX - r.left + 14) + 'px';
        tip.style.top = e.clientY - r.top + 14 + 'px';
      });
      el.addEventListener('pointerleave', () => ((tip.hidden = true), el.classList.remove('hot')));
    });
  }

  function cartesian(pts, series, W, H, anim, type, numericX) {
    const m = { l: 64, r: 20, t: 18, b: 64 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const vals = pts.flatMap((p) => p.ys).filter(Number.isFinite);
    const min = Math.min(0, ...vals);
    const max = Math.max(0, ...vals);
    const { lo, hi, ticks } = niceTicks(min, max);
    const y = (v) => m.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
    let xs;
    let xTicks = [];
    if (type === 'scatter' && numericX) {
      const xv = pts.map((p) => num(p.x)).filter(Number.isFinite);
      const nx = niceTicks(Math.min(...xv), Math.max(...xv));
      xs = (p) => m.l + ((num(p.x) - nx.lo) / (nx.hi - nx.lo || 1)) * iw;
      xTicks = nx.ticks.map((t) => ({ x: m.l + ((t - nx.lo) / (nx.hi - nx.lo || 1)) * iw, label: short(t) }));
    } else {
      const band = iw / Math.max(1, pts.length);
      xs = (p, i) => m.l + band * i + band / 2;
      const every = Math.ceil(pts.length / Math.max(1, Math.floor(iw / 70)));
      xTicks = pts.map((p, i) => ({ x: xs(p, i), label: valStr(p.x), i })).filter((t) => t.i % every === 0);
    }
    const parts = [];
    parts.push(`<g class="axis">${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 10}" y="${y(t) + 4}" text-anchor="end">${esc(short(t))}</text>`).join('')}</g>`);
    parts.push(
      `<g class="axis x">${xTicks
        .map((t) => `<text x="${t.x}" y="${H - m.b + 18}" text-anchor="end" transform="rotate(-30 ${t.x} ${H - m.b + 18})">${esc(String(t.label).slice(0, 16))}</text>`)
        .join('')}</g>`,
    );
    parts.push(`<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`);
    const tipFor = (p, s, v) => `<b>${esc(valStr(p.x))}</b><br><span style="color:${s.color}">●</span> ${esc(s.name)}: <b>${esc(fmtNum(v))}</b>`;
    if (type === 'bar') {
      const band = iw / Math.max(1, pts.length);
      const gw = Math.min(64, band * 0.78);
      const bw = gw / series.length;
      pts.forEach((p, i) =>
        series.forEach((s, k) => {
          const v = p.ys[k];
          if (!Number.isFinite(v)) return;
          const x0 = xs(p, i) - gw / 2 + k * bw;
          const y0 = Math.min(y(v), y(0));
          const hh = Math.max(1, Math.abs(y(v) - y(0)));
          parts.push(`<rect class="bar${anim ? ' grow' : ''}" style="--d:${Math.min(i, 40) * 18 + k * 60}ms;transform-origin:${x0}px ${y(0)}px" x="${x0 + 1}" y="${y0}" width="${Math.max(1, bw - 2)}" height="${hh}" rx="${Math.min(5, bw / 3)}" fill="url(#cg${k})" data-tip="${esc(tipFor(p, s, v))}"/>`);
        }),
      );
    } else {
      series.forEach((s, k) => {
        const P = pts.map((p, i) => [xs(p, i), p.ys[k]]).filter(([, v]) => Number.isFinite(v)).map(([x, v]) => [x, y(v)]);
        if (!P.length) return;
        if (type !== 'scatter') {
          const d = smooth(P);
          if (type === 'area') parts.push(`<path class="area${anim ? ' fade' : ''}" d="${d} L ${P.at(-1)[0]} ${y(0)} L ${P[0][0]} ${y(0)} Z" fill="url(#ca${k})"/>`);
          parts.push(`<path class="line${anim ? ' draw' : ''}" style="--d:${k * 160}ms" d="${d}" stroke="${s.color}" pathLength="1"/>`);
        }
        pts.forEach((p, i) => {
          const v = p.ys[k];
          if (!Number.isFinite(v)) return;
          parts.push(`<circle class="pt${anim ? ' pop' : ''}${type === 'scatter' ? ' big' : ''}" style="--d:${300 + Math.min(i, 60) * 12}ms" cx="${xs(p, i)}" cy="${y(v)}" r="${type === 'scatter' ? 5 : 3.5}" fill="${s.color}" data-tip="${esc(tipFor(p, s, v))}"/>`);
        });
      });
    }
    const defs = series
      .map(
        (s, k) =>
          `<linearGradient id="cg${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}"/><stop offset="1" stop-color="${s.color}" stop-opacity=".55"/></linearGradient><linearGradient id="ca${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".38"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`,
      )
      .join('');
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    el.setAttribute('width', W);
    el.setAttribute('height', H);
    el.classList.add('chart-svg');
    el.innerHTML = `<defs>${defs}</defs>${parts.join('')}`;
    return el;
  }

  function donut(pts, s, W, H, anim) {
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) / 2 - 40;
    const sw = r * 0.38;
    const C = 2 * Math.PI * (r - sw / 2);
    const items = pts.map((p) => ({ x: p.x, v: Math.max(0, p.ys[0]) || 0 }));
    const tot = items.reduce((a, b) => a + b.v, 0) || 1;
    let acc = 0;
    const parts = items.map((it, i) => {
      const len = (it.v / tot) * C;
      const off = -acc;
      acc += len;
      const pct = ((it.v / tot) * 100).toFixed(1);
      return `<circle class="slice${anim ? ' sweep' : ''}" style="--len:${len}px;--c:${C}px;--d:${i * 70}ms" cx="${cx}" cy="${cy}" r="${r - sw / 2}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="${sw}" stroke-dasharray="${len} ${C}" stroke-dashoffset="${off}" transform="rotate(-90 ${cx} ${cy})" data-tip="<b>${esc(valStr(it.x))}</b><br>${esc(s.name)}: <b>${esc(fmtNum(it.v))}</b> (${pct}%)"/>`;
    });
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    el.setAttribute('width', W);
    el.setAttribute('height', H);
    el.classList.add('chart-svg');
    el.innerHTML = `${parts.join('')}<text class="donut-total" x="${cx}" y="${cy - 2}" text-anchor="middle">${esc(short(tot))}</text><text class="donut-label" x="${cx}" y="${cy + 20}" text-anchor="middle">${esc(s.name)}</text>`;
    return el;
  }

  requestAnimationFrame(draw);
  new ResizeObserver(() => {
    const w = stage.clientWidth;
    if (Math.abs((stage._w || 0) - w) > 40) {
      stage._w = w;
      draw();
    }
  }).observe(stage);
}

// Catmull-Rom → cubic Bézier for gentle curves
function smooth(P) {
  if (P.length < 3) return 'M ' + P.map((p) => p.join(' ')).join(' L ');
  let d = `M ${P[0][0]} ${P[0][1]}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2] || p2;
    const t = 0.18;
    d += ` C ${p1[0] + (p2[0] - p0[0]) * t} ${p1[1] + (p2[1] - p0[1]) * t}, ${p2[0] - (p3[0] - p1[0]) * t} ${p2[1] - (p3[1] - p1[1]) * t}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function exportMenu(e, stage, title) {
  const svg = stage.querySelector('svg');
  if (!svg) return;
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--solid').trim() || '#10131f';
  const text = css.getPropertyValue('--text-2').trim() || '#a4aacb';
  const grid = css.getPropertyValue('--line').trim() || 'rgba(150,165,255,.1)';
  const clone = svg.cloneNode(true);
  clone.querySelectorAll('[class]').forEach((n) => n.classList.remove('grow', 'draw', 'pop', 'sweep', 'fade', 'hot'));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const style = `<style>text{font:12px Inter,system-ui,sans-serif;fill:${text}}.gridline{stroke:${grid}}.baseline{stroke:${grid};stroke-width:1.5}.line{fill:none;stroke-width:2.5}.donut-total{font:700 30px Inter,sans-serif;fill:${css.getPropertyValue('--text').trim()}}</style>`;
  clone.insertAdjacentHTML('afterbegin', `${style}<rect width="100%" height="100%" fill="${bg}"/>`);
  const src = new XMLSerializer().serializeToString(clone);
  const name = String(title).replace(/[^\w-]+/g, '_') || t('chart');
  const menu = document.createElement('div');
  void menu;
  import('./core.js').then(({ showMenu }) =>
    showMenu(e, [
      { label: t('PNG (high resolution)'), icon: 'image', action: () => toPng(src, svg, `${name}.png`) },
      { label: t('SVG (vector)'), icon: 'file-image', action: () => downloadText(`${name}.svg`, src, 'image/svg+xml') },
    ]),
  );
}

function toPng(src, svg, file) {
  const w = Number(svg.getAttribute('width'));
  const hgt = Number(svg.getAttribute('height'));
  const img = new Image();
  img.onload = () => {
    const c = h('canvas', { width: w * 2, height: hgt * 2 });
    const ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);
    c.toBlob((b) => {
      const a = h('a', { href: URL.createObjectURL(b), download: file });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src);
}
