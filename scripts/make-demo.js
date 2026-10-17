// Builds demo/toko.db — a small shop database for trying DBStudio without a DB server.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo', 'toko.db');
mkdirSync(dirname(file), { recursive: true });
rmSync(file, { force: true });
const db = new DatabaseSync(file);

db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE kategori (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL UNIQUE
);

CREATE TABLE produk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  nama TEXT NOT NULL,
  kategori_id INTEGER REFERENCES kategori(id),
  harga INTEGER NOT NULL,
  stok INTEGER NOT NULL DEFAULT 0,
  aktif INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE pelanggan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  email TEXT,
  kota TEXT,
  terdaftar TEXT NOT NULL DEFAULT (date('now'))
);

CREATE TABLE pesanan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pelanggan_id INTEGER NOT NULL REFERENCES pelanggan(id),
  tanggal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','dibayar','dikirim','selesai','batal'))
);

CREATE TABLE pesanan_item (
  pesanan_id INTEGER NOT NULL REFERENCES pesanan(id),
  produk_id INTEGER NOT NULL REFERENCES produk(id),
  jumlah INTEGER NOT NULL,
  harga_satuan INTEGER NOT NULL,
  PRIMARY KEY (pesanan_id, produk_id)
);

-- No primary key on purpose: DBStudio shows it read-only.
CREATE TABLE log_aktivitas (
  waktu TEXT NOT NULL,
  pesan TEXT NOT NULL
);

CREATE VIEW laporan_penjualan AS
SELECT p.id AS pesanan_id, p.tanggal, pl.nama AS pelanggan, pl.kota, p.status,
       SUM(i.jumlah * i.harga_satuan) AS total
FROM pesanan p
JOIN pelanggan pl ON pl.id = p.pelanggan_id
JOIN pesanan_item i ON i.pesanan_id = p.id
GROUP BY p.id;
`);

const kategori = ['Makanan', 'Minuman', 'Elektronik', 'Alat Tulis', 'Kebersihan'];
const insK = db.prepare('INSERT INTO kategori (nama) VALUES (?)');
for (const k of kategori) insK.run(k);

const produk = [
  ['MKN-001', 'Indomie Goreng', 1, 3500, 240],
  ['MKN-002', 'Beras Pandan Wangi 5kg', 1, 78000, 35],
  ['MKN-003', 'Gula Pasir 1kg', 1, 17500, 60],
  ['MKN-004', 'Minyak Goreng 2L', 1, 36000, 42],
  ['MNM-001', 'Teh Botol 450ml', 2, 5000, 150],
  ['MNM-002', 'Kopi Kapal Api 165g', 2, 14500, 80],
  ['MNM-003', 'Air Mineral 600ml', 2, 3500, 300],
  ['ELK-001', 'Lampu LED 12W', 3, 32000, 25],
  ['ELK-002', 'Kabel Roll 5m', 3, 65000, 12],
  ['ELK-003', 'Baterai AA (4 pcs)', 3, 24000, 48],
  ['ATK-001', 'Buku Tulis 58 lbr', 4, 4500, 200],
  ['ATK-002', 'Pulpen Standard', 4, 2500, 350],
  ['ATK-003', 'Map Plastik', 4, 3000, 0],
  ['KBR-001', 'Sabun Cuci Piring 800ml', 5, 15500, 55],
  ['KBR-002', 'Deterjen Bubuk 1kg', 5, 22000, 40],
];
const insP = db.prepare('INSERT INTO produk (sku, nama, kategori_id, harga, stok) VALUES (?, ?, ?, ?, ?)');
for (const p of produk) insP.run(...p);

const pelanggan = [
  ['Budi Santoso', 'budi@contoh.id', 'Jakarta'],
  ['Siti Rahmawati', 'siti@contoh.id', 'Bandung'],
  ['Agus Wijaya', null, 'Surabaya'],
  ['Dewi Lestari', 'dewi@contoh.id', 'Yogyakarta'],
  ['Rizky Pratama', 'rizky@contoh.id', 'Medan'],
  ['Nur Aini', 'nur@contoh.id', 'Makassar'],
  ['Hendra Gunawan', null, 'Semarang'],
  ['Putri Ayu', 'putri@contoh.id', 'Denpasar'],
];
const insC = db.prepare("INSERT INTO pelanggan (nama, email, kota, terdaftar) VALUES (?, ?, ?, date('2026-01-01', ?))");
pelanggan.forEach((c, i) => insC.run(...c, `+${i * 17} days`));

// Deterministic pseudo-random data so the demo is identical on every run.
let seed = 42;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor(seed / 65536) % n; // high bits: the low bits of an LCG cycle with a short period
};
const statuses = ['baru', 'dibayar', 'dikirim', 'selesai', 'selesai', 'selesai', 'batal'];
const insO = db.prepare("INSERT INTO pesanan (pelanggan_id, tanggal, status) VALUES (?, date('2026-03-01', ?), ?)");
const insI = db.prepare('INSERT OR IGNORE INTO pesanan_item (pesanan_id, produk_id, jumlah, harga_satuan) VALUES (?, ?, ?, ?)');
const insL = db.prepare('INSERT INTO log_aktivitas (waktu, pesan) VALUES (?, ?)');
for (let o = 1; o <= 60; o++) {
  const cust = 1 + rnd(pelanggan.length);
  const day = rnd(200);
  insO.run(cust, `+${day} days`, statuses[rnd(statuses.length)]);
  const items = 1 + rnd(4);
  for (let k = 0; k < items; k++) {
    const pid = 1 + rnd(produk.length);
    insI.run(o, pid, 1 + rnd(5), produk[pid - 1][3]);
  }
  insL.run(`2026-03-01 08:${String(o % 60).padStart(2, '0')}:00`, `Pesanan #${o} dibuat oleh pelanggan #${cust}`);
}

db.close();
console.log('Demo database written to', file);
