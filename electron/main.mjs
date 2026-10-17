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
      buttons: ['Tutup tanpa menyimpan', 'Batal'],
      defaultId: 1,
      cancelId: 1,
      title: 'Perubahan belum disimpan',
      message: 'Ada perubahan yang belum disimpan.',
      detail: 'Jika ditutup sekarang, perubahan tersebut akan hilang.',
    });
    if (choice === 0) e.preventDefault();
  });

  // Ask where to save exports instead of dropping them silently into ~/Downloads.
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Simpan file', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
  });

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
          { label: 'Tentang DBStudio', click: send("location.hash = 'about'") },
          { type: 'separator' },
          { label: 'Koneksi baru…', accelerator: 'CmdOrCtrl+Shift+N', click: send("document.querySelector('#btn-new-conn')?.click()") },
          { label: 'Palet perintah', accelerator: 'CmdOrCtrl+K', click: send("document.querySelector('#btn-palette')?.click()") },
          { type: 'separator' },
          { role: 'quit', label: 'Keluar' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo', label: 'Urungkan' },
          { role: 'redo', label: 'Ulangi' },
          { type: 'separator' },
          { role: 'cut', label: 'Potong' },
          { role: 'copy', label: 'Salin' },
          { role: 'paste', label: 'Tempel' },
          { role: 'selectAll', label: 'Pilih semua' },
        ],
      },
      {
        label: 'Tampilan',
        submenu: [
          { role: 'reload', label: 'Muat ulang' },
          { role: 'toggleDevTools', label: 'Developer tools' },
          { type: 'separator' },
          { role: 'resetZoom', label: 'Ukuran normal' },
          { role: 'zoomIn', label: 'Perbesar' },
          { role: 'zoomOut', label: 'Perkecil' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: 'Layar penuh' },
        ],
      },
      {
        label: 'Bantuan',
        submenu: [
          { label: 'Tentang pengembang', click: send("location.hash = 'about'") },
          { label: 'Situs sifirman.com', click: () => shell.openExternal('https://sifirman.com') },
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
    const started = await startServer({ port: 0 });
    server = started.server;
    baseUrl = `http://127.0.0.1:${started.port}/`;
  } catch (e) {
    dialog.showErrorBox('DBStudio gagal dijalankan', String(e?.stack || e));
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
