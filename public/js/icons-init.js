// Fill the static shell buttons with icons.
import { $, $$, icon } from './core.js';

const RAIL = { connections: 'plug', explorer: 'database', jobs: 'list-checks', erd: 'workflow', copy: 'copy-plus', transfer: 'arrow-down-up', compare: 'git-compare', server: 'server' };
for (const b of $$('.rail-btn[data-panel], .rail-btn[data-tool]')) b.insertAdjacentHTML('afterbegin', icon(RAIL[b.dataset.panel || b.dataset.tool]));
$('#btn-palette').innerHTML = icon('command');
$('#btn-about').innerHTML = icon('info');
$('#btn-about').onclick = () => import('./core.js').then(({ app }) => app.openAbout());
$('#btn-theme').innerHTML = icon('sun-moon');
$('#btn-new-conn').innerHTML = icon('plus') + '<span>Baru</span>';
$('#btn-refresh-jobs').innerHTML = icon('refresh-cw');
$('#btn-new-query').innerHTML = icon('plus') + '<span>Query</span>';
$('#btn-new-query').onclick = () => import('./core.js').then(({ app }) => app.newQueryTab());
