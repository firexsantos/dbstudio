# Changelog

All notable changes to DBStudio are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-10-17

### Added

- **Connection workspaces** — several connections open at the same time, each in its own big tab above the explorer,
  with its own explorer, database/schema and tabs. Switching never disconnects the others.
  - Open the same server twice to work in **two databases/schemas side by side** ("Open another database in a new tab").
  - Each tab shows the connection's color, engine and database; drag to reorder, middle-click or × to close.
  - `Alt+1…9` jumps to a connection, `Ctrl+Alt+←/→` cycles; the command palette lists open connections.
  - Open connections and their query tabs are restored after a restart.
  - Closing a connection asks first when its tabs have unsaved changes or SQL.

- **Import connections from SQLyog** (`.sycs` from *Tools → Export Connections*): host, port, user, default database,
  SSL, SSH tunnel (password or key) and the object-browser color. Saved passwords — database and SSH — are restored.
  UTF-16 exports are read as well; HTTP tunnels and Windows key paths are flagged in the preview.

### Changed

- Clicking another connection now opens it next to the current one instead of replacing it.
- MySQL/MariaDB connections without a default database open the first user database instead of `information_schema`.

## [0.3.0] — 2026-10-17

A big feature release inspired by Navicat, plus a bilingual interface.

### Added

- **Multi-language interface — English & Indonesian.** English is the default; switch in **Settings** and the whole app
  (menus, dialogs, messages, background jobs, the desktop menu and generated data dictionaries) follows.
- **Settings page** (`Ctrl+,`, gear in the rail, or the command palette): interface language, theme (system / dark / light)
  and the data folder location. Preferences are stored in `~/.dbstudio/settings.json`.
- **Connection manager Pro** — groups/folders, favorites, search, drag & drop between groups, sort by name or last used,
  rename/remove groups.
- **Import & export connections** — DBStudio JSON (optionally encrypted with a passphrase, AES-256-GCM + scrypt),
  **Navicat** `.ncx` (passwords decrypted) and **DBeaver** `data-sources.json` + `credentials-config.json`.
  Preview with duplicate detection before anything is saved.
- **Data sync** — compare table contents row by row across databases, servers and engines, review inserts/updates/deletes
  per table, then apply in transactions or save the sync script as SQL.
- **Test data generator** — realistic data (Indonesian names, addresses, phone numbers, products…) that respects column types,
  `UNIQUE` (including composite keys), `ENUM`/`SET`/`CHECK` lists and foreign keys; append or replace, with a live preview.
- **Visual Query Builder** — add tables, joins are suggested from foreign keys, pick columns, aggregates, filters,
  `GROUP BY`/`HAVING`, sorting and limits without typing SQL; the generated SQL opens in a query tab.
- **Charts** — turn any query result into an animated bar, line, area, donut or scatter chart; export PNG/SVG.
- **Find in database** — search a value across every table and column at once.
- **Record form view, value viewer & FK navigation** — one row per page, JSON tree / image BLOB / hex viewers,
  `Ctrl+click` a foreign-key cell to jump to the referenced row, list incoming references.
- **Excel export** (`.xlsx`, no extra dependency) plus CSV, CSV (;), JSON, Markdown, HTML and SQL `INSERT` from query results and tables.
- **Data dictionary** — a shareable HTML or Markdown document of a whole schema (columns, indexes, relations, row counts).
- **Backup & restore** — one-click compressed backups with history, restore, download and delete.
- **Tools panel** listing every feature, and a **What's new** dialog after updates.

### Changed

- The theme choice is now also saved server-side, so the desktop app keeps it between launches.
- Backups and settings honour `DBSTUDIO_DATA_DIR` for portable installs and tests.
- The palette finds commands by English *and* Indonesian words, whatever the interface language.
- Background job items now carry a stable state id next to their translated label.
- The **Data dictionary** document and SQL dump/sync-script headers are written in the interface language.

### Fixed

- Desktop app: the embedded server now prefers a fixed port (51740), so saved query tabs, history and favorites
  survive restarts (they were lost because every launch used a new random port, i.e. a new browser origin).
- Importing an encrypted connection file now detects a missing/wrong passphrase by error code instead of message text.

## [0.2.0] — 2026-10-17

First public release.

### Added

- MySQL/MariaDB, PostgreSQL and SQLite connections, with SSH tunnels (password, private key, ssh-agent) and SSL.
- Explorer for databases/schemas, tables, views, routines, triggers and events.
- Table designer (columns, keys, indexes, foreign keys) with live SQL preview; create/drop databases and schemas.
- Interactive ERD with auto layout, minimap, drag-to-relate and SVG/PNG export.
- Editable data grid saved in one transaction; query editor with autocomplete, EXPLAIN, formatter, history and favorites.
- Copy tables across databases, servers and engines; SQL dumps, CSV/JSON export, SQL and CSV import; schema compare & sync.
- Server tools: process list, variables, status, users & privileges.
- Desktop app for Linux (`.deb`, AppImage) and Windows (installer), with an About page.

[0.4.0]: https://github.com/firexsantos/dbstudio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/firexsantos/dbstudio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/firexsantos/dbstudio/releases/tag/v0.2.0
