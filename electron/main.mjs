// DBStudio desktop app: runs the DBStudio server in-process on a free loopback port and shows it in a window.
import { app, BrowserWindow, Menu, shell, dialog, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ICON = join(ROOT, 'build', 'icons', '512x512.png');

app.setName('DBStudio');
if (process.platform === 'win32') app.setAppUserModelId('com.sifirman.dbstudio');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null;
let baseUrl = null;
// Replaced by lib/i18n.js's t() once the server has started (it reads the saved language from settings.json).
let t = (s) => s;
let lang = () => 'en';

// The bundled demo database lives inside the read-only app archive; give the user a writable copy.
function prepareDemo() {
  const src = join(ROOT, 'demo', 'toko.db');
  const dst = join(app.getPath('userData'), 'demo', 'toko.db');
  if (!existsSync(dst) && existsSync(src)) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  process.env.DBSTUDIO_DEMO_FILE = dst;
}

function isInternal(url) {
  return baseUrl && url.startsWith(baseUrl);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'DBStudio',
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#05060b' : '#eef0f8',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());

  // Links to websites (profile, WhatsApp, e-mail) open in the system browser/apps.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url) && /^(https?:|mailto:)/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isInternal(url)) return;
    e.preventDefault();
    if (/^(https?:|mailto:)/.test(url)) shell.openExternal(url);
  });

  // The page blocks unloading while a tab has unsaved changes — ask instead of silently refusing to close.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: [t('Close without saving'), t('Cancel')],
      defaultId: 1,
      cancelId: 1,
      title: t('Unsaved changes'),
      message: t('There are unsaved changes.'),
      detail: t('If you close now, those changes will be lost.'),
    });
    if (choice === 0) e.preventDefault();
  });

  // Ask where to save exports instead of dropping them silently into ~/Downloads.
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: t('Save file'), defaultPath: join(app.getPath('downloads'), item.getFilename()) });
  });

  // The menu follows the UI language; switching language reloads the page, so rebuild it on every load.
  win.webContents.on('did-finish-load', buildMenu);
  win.loadURL(baseUrl);
  win.on('closed', () => (win = null));
}

function buildMenu() {
  const send = (js) => () => win?.webContents.executeJavaScript(js).catch(() => {});
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'DBStudio',
        submenu: [
          { label: t('About DBStudio'), click: send("location.hash = 'about'") },
          { type: 'separator' },
          { label: t('Settings…'), accelerator: 'CmdOrCtrl+,', click: send("document.querySelector('#btn-settings')?.click()") },
          { type: 'separator' },
          { label: t('New connection…'), accelerator: 'CmdOrCtrl+Shift+N', click: send("document.querySelector('#btn-new-conn')?.click()") },
          { label: t('Command palette'), accelerator: 'CmdOrCtrl+K', click: send("document.querySelector('#btn-palette')?.click()") },
          { type: 'separator' },
          { role: 'quit', label: t('Quit') },
        ],
      },
      {
        label: t('Edit'),
        submenu: [
          { role: 'undo', label: t('Undo') },
          { role: 'redo', label: t('Redo') },
          { type: 'separator' },
          { role: 'cut', label: t('Cut') },
          { role: 'copy', label: t('Copy') },
          { role: 'paste', label: t('Paste') },
          { role: 'selectAll', label: t('Select all') },
        ],
      },
      {
        // "View" is already a key for database views ("View" in Indonesian too), so the menu title is picked here.
        label: lang() === 'id' ? 'Tampilan' : 'View',
        submenu: [
          { role: 'reload', label: t('Reload') },
          { role: 'toggleDevTools', label: t('Developer tools') },
          { type: 'separator' },
          { role: 'resetZoom', label: t('Actual size') },
          { role: 'zoomIn', label: t('Zoom in') },
          { role: 'zoomOut', label: t('Zoom out') },
          { type: 'separator' },
          { role: 'togglefullscreen', label: t('Full screen') },
        ],
      },
      {
        label: t('Help'),
        submenu: [
          { label: t('About the developer'), click: send("location.hash = 'about'") },
          { label: t('Website sifirman.com'), click: () => shell.openExternal('https://sifirman.com') },
        ],
      },
    ]),
  );
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  try {
    prepareDemo();
    const { startServer } = await import('../server.js');
    // A fixed port keeps the page origin stable, so localStorage (query tabs, history, favorites) survives restarts.
    // If it is taken (e.g. by another program), fall back to any free port.
    const started = await startServer({ port: 51740 }).catch(() => startServer({ port: 0 }));
    server = started.server;
    baseUrl = `http://127.0.0.1:${started.port}/`;
    // Same process as the server, so this shares its settings (and sees language switches immediately).
    ({ t, lang } = await import('../lib/i18n.js'));
  } catch (e) {
    // Runs before the translations are available, so this one stays in English.
    dialog.showErrorBox('DBStudio failed to start', String(e?.stack || e));
    app.quit();
    return;
  }
  buildMenu();
  createWindow();
});

app.on('window-all-closed', async () => {
  try {
    const { stopServer } = await import('../server.js');
    if (server) await stopServer(server);
  } finally {
    app.quit();
  }
});
