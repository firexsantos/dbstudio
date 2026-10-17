<p align="center">
  <img src="build/icons/128x128.png" width="96" alt="DBStudio">
</p>

<h1 align="center">DBStudio</h1>

<p align="center">
  A database manager for <b>MySQL/MariaDB</b>, <b>PostgreSQL</b> &amp; <b>SQLite</b> —<br>
  combining the power of <b>SQLYog</b> (SSH tunneling, copying tables across servers, schema sync, user management)
  with the experience of <b>Beekeeper Studio</b> (query tabs, editable grid, modern interface).
</p>

<p align="center">
  <a href="https://github.com/firexsantos/dbstudio/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/firexsantos/dbstudio?color=8b5cff"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20Web-36d6ff">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-2dffb3">
</p>

<p align="center"><img src="docs/screenshots/welcome.webp" alt="DBStudio start screen" width="900"></p>

> The interface is available in **English** (default) and **Bahasa Indonesia** — switch in **Settings** (`Ctrl+,`).
> See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## Download

Get the latest installers from the **[Releases](https://github.com/firexsantos/dbstudio/releases/latest)** page:

| System | File | How to install |
|---|---|---|
| Ubuntu / Debian | `DBStudio-<version>-amd64.deb` | `sudo apt install ./DBStudio-*-amd64.deb` |
| Other Linux | `DBStudio-<version>-x86_64.AppImage` | `chmod +x DBStudio-*.AppImage`, then run it |
| Windows 10/11 | `DBStudio-Setup-<version>.exe` | Run the installer* |

\* The installer is not code-signed yet, so Windows SmartScreen shows a warning —
choose **More info → Run anyway**. Verify downloads with `SHA256SUMS.txt`.

## Screenshots

| | |
|---|---|
| ![Interactive ERD](docs/screenshots/erd.webp) | ![Table designer](docs/screenshots/designer.webp) |
| **ERD** — drag a column onto another to create a relation | **Table Designer** — live SQL preview |
| ![Table data](docs/screenshots/table-data.webp) | ![Query editor, light theme](docs/screenshots/query-light.webp) |
| **Data** — inline editing, saved in a single transaction | **Query** — editor with autocomplete (light theme) |

## Features

| Area | What you can do |
|---|---|
| **Connections** | MySQL/MariaDB, PostgreSQL, SQLite · **SSH tunnel** (password / private key / ssh-agent) · SSL · color tags · connection test |
| **Explorer** | Databases/schemas, tables, views, procedures/functions, triggers, events · search · right-click for every action |
| **Databases** | Create/drop databases (MySQL: charset & collation) · new schema or database (PostgreSQL) |
| **Table Designer** | Create & alter tables: columns (drag to reorder), PK, auto increment, defaults, comments, **indexes**, **foreign keys** · live SQL preview |
| **ERD** | Interactive relationship diagram · auto layout · zoom/pan · minimap · **drag column → column to create a relation** · click a line to drop it · export SVG/PNG |
| **Data** | Editable grid (edit, insert, delete, set NULL) saved in **one transaction** · WHERE filter · sorting · paging · copy as INSERT/JSON |
| **Query** | Editor with autocomplete · run all / statement at cursor (F9) · **EXPLAIN** · **SQL formatter** · history & favorites · CSV/JSON |
| **Copy tables** | To another database, **another server**, even **another engine** (e.g. MySQL → PostgreSQL) · structure / data / both · relations included · per-table progress |
| **Export / Import** | SQL dumps (optionally in another engine's dialect) · CSV/JSON/SQL export · `.sql` import (handles `DELIMITER`, `$$`) · **CSV import** with column mapping |
| **Schema compare** | Compare two databases/schemas (same engine) and sync the target |
| **Server** | Process list + kill · variables · status · **users & privileges** (create, change password, GRANT/REVOKE, drop) |
| **Connection manager** | Groups/folders · favorites · search · drag & drop · sort by name or last used |
| **Multiple connections** | Keep several connections open at once, each in its own tab with its own explorer and tabs — even two databases of the same server side by side |
| **Import / export connections** | DBStudio JSON (optionally passphrase-encrypted) · import from **Navicat** (`.ncx`), **SQLyog** (`.sycs`) and **DBeaver** · duplicate detection |
| **Data sync** | Compare table **contents** row by row across databases, servers and engines · apply in transactions or save the SQL script |
| **Test data generator** | Realistic data that respects types, `UNIQUE`, `ENUM`/`CHECK` lists and foreign keys · append or replace · live preview |
| **Query Builder** | Visual: add tables, joins from foreign keys, columns, aggregates, filters, `GROUP BY`/`HAVING`, sort — no SQL typing needed |
| **Charts** | Bar, line, area, donut and scatter charts from any query result · PNG/SVG export |
| **Find in database** | Search a value in every table and column at once |
| **Record tools** | Form view (one row per page) · JSON / image / hex value viewer · `Ctrl+click` a foreign key to jump to its row |
| **Export formats** | **Excel (.xlsx)**, CSV, JSON, Markdown, HTML, SQL `INSERT` — from query results and tables |
| **Data dictionary** | Shareable HTML / Markdown documentation of a whole schema |
| **Backup & restore** | One-click compressed backups with history, restore and download |
| **More** | Command palette `Ctrl+K` · **English / Indonesian** interface · dark/light theme · every schema change goes through an editable **SQL preview** |

## Running from source

```bash
npm install        # once
npm start          # → open http://localhost:5174
```

Requires Node.js ≥ 22.5 (SQLite uses Node's built-in `node:sqlite` — no native modules).
No database server at hand? Click **“Try the demo”** on the start screen (regenerate it with `npm run demo`).

## Building the desktop app

```bash
npm run app        # run as an Electron desktop app (no browser needed)
npm run dist       # Linux packages → dist/*.deb and dist/*.AppImage
npm run dist:win   # Windows installer → dist/DBStudio-Setup-<version>.exe (needs Wine on Linux)
```

The desktop app runs the DBStudio server inside the app on port 51740 (or a free port if that is taken), bound to `127.0.0.1`, so it never clashes with
`npm start`. Saved connections and settings are shared (`~/.dbstudio/connections.json`, `~/.dbstudio/settings.json`).

> Running `npm run app` from a VS Code terminal: VS Code sets `ELECTRON_RUN_AS_NODE=1`, so start it with
> `env -u ELECTRON_RUN_AS_NODE npm run app`.

## SSH, both ways

**1. Databases on remote servers via an SSH tunnel** (like SQLYog): open the **SSH Tunnel** tab in the connection dialog and
enter the SSH host/user plus a password or private key. The database *host* on the General tab is resolved from the SSH
server's side — usually `127.0.0.1`.

**2. Using a DBStudio instance that runs on a server**, from your laptop:

```bash
ssh -L 8080:localhost:5174 user@server     # then open http://localhost:8080
```

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` / `Ctrl+P` | Command palette |
| `Ctrl+Enter` | Run selection / whole editor |
| `F9` / `Ctrl+Shift+Enter` | Run statement at cursor |
| `Ctrl+Shift+F` | Format SQL |
| `Ctrl+S` | Save changes (table data / designer) |
| `Alt+N` | New query tab |
| `Alt+1` … `Alt+9` · `Ctrl+Alt+←/→` | Jump to / cycle through open connections |
| `Ctrl+,` | Settings (language, theme) |
| `Space` | Open the value viewer for the selected cell |
| `Ctrl+click` | Follow a foreign key to the referenced row |
| Double-click / `Enter` / `F2` · `Tab` | Edit cell · move to next cell |
| `Delete` | Mark selected rows for deletion |

## Security

- The server only listens on `127.0.0.1`; any Host other than `localhost`/`127.0.0.1` is rejected (DNS-rebinding protection).
- Every API request must carry the `X-DBStudio` header (CSRF protection against other websites). Export downloads use a random per-job token.
- A strict Content-Security-Policy only allows scripts, styles and fonts from the app itself.
- Connections are stored in `~/.dbstudio/connections.json` (mode 600). Database and SSH passwords are never sent back to the browser.

## Self-test

```bash
npm run selftest
DBSTUDIO_TEST_MYSQL='mysql://user:pass@127.0.0.1:3306' \
DBSTUDIO_TEST_PG='postgres://user:pass@127.0.0.1:5432/postgres' npm run selftest
```

~560 checks: schema introspection, CREATE/ALTER, a 3×3 cross-engine copy matrix, dump → import across dialects, schema
compare, statement splitting, connection import/export (Navicat, DBeaver, encrypted), Excel output, data sync across engines,
the test data generator, find/data dictionary/backup & restore, and translations/settings. MySQL: creates & drops temporary `dbst_*` databases; PostgreSQL: temporary schemas.
Existing data is never touched.

## Translations

English strings in the source are the translation keys: UI code calls `t('Delete {n} rows?', { n })`, and
[`public/js/locales/id.js`](public/js/locales/id.js) maps each English key to Indonesian. The same dictionary is used by
the server (job progress, errors, data dictionaries) and the desktop menu. To add a language, add a `locales/<code>.js`
file with the same keys and register it in `public/js/i18n.js` and `lib/settings.js`.

## Project layout

```
server.js            Express API, static files, downloads
lib/drivers.js       MySQL / PostgreSQL / SQLite drivers: sessions, transactions, metadata, server tools
lib/ssh.js           SSH tunnels (ssh2)
lib/schema.js        schema introspection, CREATE/ALTER, cross-engine type mapping, schema compare
lib/copy.js          copy tables across databases/servers/engines
lib/transfer.js      SQL dumps, CSV/JSON export, SQL import
lib/jobs.js          background jobs with progress
lib/connio.js        connection import/export (DBStudio, Navicat, SQLyog, DBeaver)
lib/datasync.js      row-level data compare & sync
lib/datagen.js       test data generator
lib/finder.js        find a value across a whole database
lib/dictionary.js    data dictionary (HTML / Markdown)
lib/backup.js        backup & restore history
lib/xlsx.js          dependency-free Excel writer
lib/settings.js      preferences (~/.dbstudio/settings.json)
lib/i18n.js          server-side translations
public/js/*.js       UI (ES modules, no build step); workspaces.js = one tab per open connection
public/js/locales/   translations (English is the source text; id.js = Indonesian)
public/css/app.css   "Nebula Glass" design system
electron/main.mjs    desktop app (Electron)
build/               app icons
```

---

Developed by **Firman Santosa** — [sifirman.com](https://sifirman.com) · admin@sifirman.com

Released under the [MIT License](LICENSE).
