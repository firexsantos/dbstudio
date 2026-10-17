// Test-data generator (Navicat-style "Data Generation"): realistic Indonesian-flavoured values,
// type/length aware, honours UNIQUE, ENUM/CHECK lists and foreign keys (parents are generated first).
import { randomUUID } from 'node:crypto';
import * as db from './drivers.js';
import { describeSchema, canonicalType } from './schema.js';
import { t, plural, num } from './i18n.js';

const { q, qualified } = db;

// ---------------------------------------------------------------- seeded PRNG
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- dictionaries
const FIRST_M = 'Budi Agus Andi Rizky Dimas Fajar Hendra Joko Eko Bayu Arif Yusuf Rahmat Fikri Ilham Teguh Wahyu Irfan Reza Bambang Dedi Hadi Iwan Rudi Adi Galih Aditya Fauzan Hafiz Raka'.split(' ');
const FIRST_F = 'Siti Dewi Putri Ayu Nur Rina Sri Wulan Indah Lestari Fitri Ratna Maya Anisa Nabila Citra Dian Intan Kartika Mega Novi Sari Tari Yuni Zahra Aulia Salsabila Nadia Kirana Laras'.split(' ');
const LAST = 'Santoso Wijaya Pratama Saputra Lestari Hidayat Nugroho Kurniawan Setiawan Gunawan Siregar Nasution Harahap Simanjuntak Sitompul Wibowo Susanto Rahmawati Permana Hakim Firmansyah Ramadhan Syahputra Utami Maharani Halim Tanjung Lubis Situmorang Purnomo'.split(' ');
const CITIES = [
  ['Jakarta', 'DKI Jakarta'], ['Surabaya', 'Jawa Timur'], ['Bandung', 'Jawa Barat'], ['Medan', 'Sumatera Utara'], ['Semarang', 'Jawa Tengah'],
  ['Makassar', 'Sulawesi Selatan'], ['Palembang', 'Sumatera Selatan'], ['Pekanbaru', 'Riau'], ['Padang', 'Sumatera Barat'], ['Denpasar', 'Bali'],
  ['Yogyakarta', 'DI Yogyakarta'], ['Malang', 'Jawa Timur'], ['Balikpapan', 'Kalimantan Timur'], ['Pontianak', 'Kalimantan Barat'], ['Manado', 'Sulawesi Utara'],
  ['Batam', 'Kepulauan Riau'], ['Banjarmasin', 'Kalimantan Selatan'], ['Jambi', 'Jambi'], ['Mataram', 'Nusa Tenggara Barat'], ['Kupang', 'Nusa Tenggara Timur'],
];
const STREETS = 'Merdeka Sudirman Thamrin Diponegoro Gatot Subroto Ahmad Yani Pahlawan Veteran Kartini Hang Tuah Imam Bonjol Gajah Mada Hayam Wuruk Pemuda Cendrawasih Melati Mawar Kenanga Riau Soekarno-Hatta'.split(' ').map((s) => s.replace(' ', ' '));
const COMPANY_PREFIX = ['PT', 'CV', 'PT', 'UD', 'PT'];
const COMPANY_WORDS = 'Maju Jaya Sejahtera Abadi Mandiri Sentosa Makmur Nusantara Prima Global Karya Utama Bersama Cipta Digital Teknologi Solusi Sinar Harapan Berkah'.split(' ');
const JOBS = 'Staf Administrasi,Manajer Pemasaran,Software Engineer,Akuntan,Desainer Grafis,Analis Data,Kepala Gudang,Customer Service,Dosen,Guru,Perawat,Teknisi,Sales Executive,HR Officer,Konsultan IT'.split(',');
const PRODUCTS = 'Kopi Arabika,Teh Melati,Beras Premium,Gula Aren,Minyak Kelapa,Sambal Bawang,Kerupuk Udang,Batik Tulis,Tas Anyaman,Sepatu Kulit,Kaos Polos,Lampu LED,Kabel USB-C,Power Bank,Earphone,Buku Tulis,Pulpen Gel,Sabun Herbal,Madu Hutan,Keripik Singkong'.split(',');
const WORDS = 'data sistem informasi layanan pengguna laporan proses aplikasi jaringan keamanan transaksi produk pelanggan pesanan pembayaran pengiriman stok gudang kualitas analisis strategi digital inovasi efisien cepat mudah aman andal terintegrasi otomatis modern'.split(' ');
const DOMAINS = ['gmail.com', 'yahoo.co.id', 'outlook.com', 'mail.id', 'contoh.id'];
const STATUS = ['aktif', 'nonaktif', 'baru', 'diproses', 'selesai', 'batal'];

// Generator ids → labels. Built per request so the labels follow the current UI language.
export function generatorList() {
  return {
    fullName: t('Full name'), firstName: t('First name'), lastName: t('Last name'), email: t('Email'), phone: t('Phone number'),
    city: t('City'), province: t('Province'), address: t('Address'), postalCode: t('Postal code'), company: t('Company'), category: t('Category'), jobTitle: t('Job title'),
    product: t('Product name'), word: t('Word'), sentence: t('Sentence'), paragraph: t('Paragraph'), username: t('Username'), password: t('Password hash'),
    url: t('URL'), ipv4: t('IPv4 address'), uuid: t('UUID'), color: t('Hex color'), status: t('Status'), int: t('Integer'), decimal: t('Decimal'),
    money: t('Amount (Rp)'), bool: t('Boolean'), date: t('Date'), datetime: t('Date & time'), time: t('Time'), year: t('Year'),
    sequence: t('Sequence number'), list: t('Pick from a list'), fk: t('Relation (FK)'), json: t('JSON'), constant: t('Fixed value'), null: t('NULL'), skip: t('Leave default'),
  };
}

// ---------------------------------------------------------------- suggestion heuristics
const CATEGORIES = 'Makanan,Minuman,Elektronik,Pakaian,Alat Tulis,Kesehatan,Kecantikan,Olahraga,Otomotif,Rumah Tangga,Mainan,Buku,Perkakas,Pertanian,Furnitur,Aksesoris,Kebersihan,Hobi,Fotografi,Musik'.split(',');

function nameForTable(table) {
  const tn = String(table || '').toLowerCase();
  if (/produk|product|barang|item|menu|obat/.test(tn)) return 'product';
  if (/kategori|category|jenis|tipe|type|golongan|kelompok/.test(tn)) return 'category';
  if (/perusahaan|company|vendor|supplier|pemasok|toko|store|cabang|branch/.test(tn)) return 'company';
  if (/kota|city|wilayah|daerah/.test(tn)) return 'city';
  return 'fullName';
}

function suggest(col, kind, ctx) {
  const n = col.name.toLowerCase();
  if (ctx.fk) return { gen: 'fk' };
  if (col.autoIncrement || col.generated) return { gen: 'skip' };
  if (ctx.list) return { gen: 'list', values: ctx.list };
  if (kind === 'uuid' || /(^|_)uuid$|guid/.test(n)) return { gen: 'uuid' };
  if (kind === 'bool' || /^(is|has)_|aktif|active|enabled|verified/.test(n)) return { gen: 'bool' };
  if (/e?mail/.test(n)) return { gen: 'email' };
  if (/phone|telp|telepon|hp|whatsapp|wa$|mobile/.test(n)) return { gen: 'phone' };
  if (/user(_?name)?$|login/.test(n)) return { gen: 'username' };
  if (/pass(word)?|pwd|hash/.test(n)) return { gen: 'password' };
  if (/first_?name|nama_depan/.test(n)) return { gen: 'firstName' };
  if (/last_?name|nama_belakang/.test(n)) return { gen: 'lastName' };
  if (/perusahaan|company|instansi/.test(n)) return { gen: 'company' };
  if (/produk|product|barang|item_name/.test(n)) return { gen: 'product' };
  if (/^(full_?name|nama_lengkap|pelanggan|customer)$/.test(n) || /nama_(pelanggan|pegawai|karyawan|user|siswa|mahasiswa|dosen|guru)/.test(n)) return { gen: 'fullName' };
  if (/^(nama|name|title|label)$/.test(n) && kind !== 'int') return { gen: nameForTable(ctx.table) };
  if (/kota|city/.test(n)) return { gen: 'city' };
  if (/provinsi|province|state/.test(n)) return { gen: 'province' };
  if (/alamat|address/.test(n)) return { gen: 'address' };
  if (/kode_?pos|zip|postal/.test(n)) return { gen: 'postalCode' };
  if (/jabatan|job|title|posisi/.test(n) && kind !== 'int') return { gen: 'jobTitle' };
  if (/url|website|link/.test(n)) return { gen: 'url' };
  if (/(^|_)ip(_|$)|ip_?address/.test(n)) return { gen: 'ipv4' };
  if (/warna|colou?r/.test(n)) return { gen: 'color' };
  if (/status/.test(n)) return { gen: 'status' };
  if (/harga|price|total|amount|nominal|gaji|salary|biaya|saldo/.test(n)) return { gen: 'money', min: 1000, max: 5_000_000 };
  if (/stok|stock|qty|jumlah|quantity|count/.test(n)) return { gen: 'int', min: 0, max: 500 };
  if (/tahun|year/.test(n) && kind === 'int') return { gen: 'year', min: 2000, max: 2026 };
  if (/umur|usia|age/.test(n)) return { gen: 'int', min: 17, max: 70 };
  if (/deskripsi|description|catatan|note|keterangan|bio|isi|content/.test(n)) return { gen: 'paragraph' };
  if (/judul|title|subject/.test(n)) return { gen: 'sentence' };
  if (/kode|code|sku|nomor|no_/.test(n) && kind !== 'int') return { gen: 'sequence', prefix: n.slice(0, 3).toUpperCase() + '-', start: 1 };
  switch (kind) {
    case 'int':
      return { gen: 'int', min: 1, max: 1000 };
    case 'decimal':
    case 'float':
    case 'double':
      return { gen: 'decimal', min: 0, max: 10000, scale: 2 };
    case 'date':
      return { gen: 'date', from: '2023-01-01', to: '2026-12-31' };
    case 'datetime':
    case 'datetimetz':
      return { gen: 'datetime', from: '2023-01-01', to: '2026-12-31' };
    case 'time':
      return { gen: 'time' };
    case 'json':
      return { gen: 'json' };
    case 'blob':
      return { gen: col.nullable ? 'null' : 'skip' };
    default:
      return { gen: 'word' };
  }
}

// ---------------------------------------------------------------- value factory
function makeFactory(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const int = (lo, hi) => Math.floor(rand() * (hi - lo + 1)) + lo;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  const person = () => {
    const female = rand() < 0.5;
    const first = pick(female ? FIRST_F : FIRST_M);
    return { first, last: pick(LAST) };
  };
  const dateBetween = (from, to) => {
    const a = Date.parse(from || '2023-01-01');
    const b = Date.parse(to || '2026-12-31');
    return new Date(a + rand() * Math.max(0, b - a));
  };
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const isoTime = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const sentence = (min = 5, max = 11) => {
    const w = Array.from({ length: int(min, max) }, () => pick(WORDS));
    return w[0][0].toUpperCase() + w.join(' ').slice(1) + '.';
  };
  return (spec, i, row) => {
    switch (spec.gen) {
      case 'fullName': {
        const p = person();
        return `${p.first} ${p.last}`;
      }
      case 'firstName':
        return person().first;
      case 'lastName':
        return pick(LAST);
      case 'email': {
        const p = row.__person || person();
        return `${slug(p.first)}.${slug(p.last)}${int(1, 999)}@${pick(DOMAINS)}`;
      }
      case 'username': {
        const p = person();
        return `${slug(p.first)}${int(10, 9999)}`;
      }
      case 'password':
        return '$2b$10$' + Array.from({ length: 53 }, () => pick('./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''))).join('');
      case 'phone':
        return `08${pick(['11', '12', '13', '21', '22', '52', '53', '57', '58', '77', '78', '81', '82', '95', '96'])}${int(1000000, 99999999)}`;
      case 'city':
        return pick(CITIES)[0];
      case 'province':
        return pick(CITIES)[1];
      case 'address':
        return `Jl. ${pick(STREETS)} No. ${int(1, 250)}, RT ${pad(int(1, 15), 3)}/RW ${pad(int(1, 12), 3)}, ${pick(CITIES)[0]}`;
      case 'postalCode':
        return String(int(10110, 99999));
      case 'company':
        return `${pick(COMPANY_PREFIX)} ${pick(COMPANY_WORDS)} ${pick(COMPANY_WORDS)}${rand() < 0.4 ? ' ' + pick(COMPANY_WORDS) : ''}`;
      case 'jobTitle':
        return pick(JOBS);
      case 'category':
        return pick(CATEGORIES);
      case 'product':
        return `${pick(PRODUCTS)}${rand() < 0.5 ? ' ' + pick(['Premium', 'Original', 'Spesial', 'Mini', 'Jumbo', '250g', '1kg', 'Pack']) : ''}`;
      case 'word':
        return pick(WORDS);
      case 'sentence':
        return sentence();
      case 'paragraph':
        return Array.from({ length: int(2, 4) }, () => sentence(6, 14)).join(' ');
      case 'url':
        return `https://www.${pick(COMPANY_WORDS).toLowerCase()}${pick(COMPANY_WORDS).toLowerCase()}.co.id/${pick(WORDS)}`;
      case 'ipv4':
        return `${int(10, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`;
      case 'uuid':
        return randomUUID();
      case 'color':
        return '#' + Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');
      case 'status':
        return pick(spec.values?.length ? spec.values : STATUS);
      case 'list':
        return pick(spec.values?.length ? spec.values : ['A', 'B', 'C']);
      case 'int':
        return int(Number(spec.min ?? 0), Number(spec.max ?? 1000));
      case 'year':
        return int(Number(spec.min ?? 2000), Number(spec.max ?? 2026));
      case 'decimal': {
        const lo = Number(spec.min ?? 0);
        const hi = Number(spec.max ?? 10000);
        return (lo + rand() * (hi - lo)).toFixed(Number(spec.scale ?? 2));
      }
      case 'money': {
        const lo = Number(spec.min ?? 1000);
        const hi = Number(spec.max ?? 1000000);
        return Math.round((lo + rand() * (hi - lo)) / 500) * 500;
      }
      case 'bool':
        return rand() < Number(spec.trueRatio ?? 0.5);
      case 'date':
        return iso(dateBetween(spec.from, spec.to));
      case 'datetime': {
        const d = dateBetween(spec.from, spec.to);
        return `${iso(d)} ${isoTime(d)}`;
      }
      case 'time':
        return isoTime(new Date(int(0, 86399) * 1000));
      case 'sequence':
        return `${spec.prefix ?? ''}${String(Number(spec.start ?? 1) + i).padStart(Number(spec.width ?? 4), '0')}`;
      case 'json':
        return JSON.stringify({ kode: int(100, 999), label: pick(WORDS), aktif: rand() < 0.7, tags: [pick(WORDS), pick(WORDS)] });
      case 'constant':
        return spec.value ?? '';
      case 'null':
        return null;
      case 'fk':
        return spec.keys?.length ? pick(spec.keys) : null;
      default:
        return null;
    }
  };
}

// ---------------------------------------------------------------- constraints discovery
async function allowedValues(conn, ns, model) {
  const out = {};
  for (const c of model.columns) {
    const m = /^(enum|set)\((.*)\)$/i.exec(String(c.type).trim());
    if (m) out[c.name] = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replaceAll("''", "'"));
  }
  const fromCheck = (def) => {
    for (const m of String(def || '').matchAll(/\(?\s*["`]?(\w+)["`]?(?:::\w+)?\s+(?:IN\s*\(|=\s*ANY\s*\(\s*(?:ARRAY)?\s*\[)([^)\]]*)[)\]]/gi)) {
      const vals = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replaceAll("''", "'"));
      if (vals.length && model.columns.some((c) => c.name === m[1])) out[m[1]] = vals;
    }
  };
  if (conn.type === 'sqlite') fromCheck(model.sql);
  if (conn.type === 'postgres') {
    const r = await db.objects(
      conn,
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'c' AND n.nspname = $1 AND t.relname = $2`,
      [ns, model.name],
    );
    r.forEach((x) => fromCheck(x.def));
  }
  if (conn.type === 'mysql') {
    const r = await db
      .objects(
        conn,
        `SELECT cc.CHECK_CLAUSE AS def FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
         WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?`,
        [ns, model.name],
      )
      .catch(() => []);
    r.forEach((x) => fromCheck(x.def));
    // MariaDB stores JSON as LONGTEXT + CHECK (json_valid(col))
    const json = r.flatMap((x) => [...String(x.def || '').matchAll(/json_valid\(\s*`?(\w+)`?\s*\)/gi)].map((m) => m[1]));
    if (json.length) out.__json = json;
  }
  return out;
}

function maxLength(type) {
  const m = /(?:char|varchar|character varying|varbinary)\s*\((\d+)\)/i.exec(String(type));
  return m ? Number(m[1]) : null;
}

/** Suggested generator per column + sample values, for the UI. */
export async function planTable(conn, ns, table) {
  const [model] = await describeSchema(conn, ns, [table]);
  if (!model) throw new Error(t('Table not found: {name}', { name: table }));
  const lists = await allowedValues(conn, ns, model);
  const fkCol = new Map();
  for (const fk of model.foreignKeys) fk.columns.forEach((c, i) => fkCol.set(c, { table: fk.refTable, column: fk.refColumns[i] }));
  const uniques = new Set([...model.primaryKey.filter(() => model.primaryKey.length === 1), ...model.indexes.filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0])]);
  const rand = mulberry32(7);
  const make = makeFactory(rand);
  const columns = model.columns.map((c) => {
    const kind = lists.__json?.includes(c.name) ? 'json' : canonicalType(c.type, conn.type).kind;
    const spec = { ...suggest(c, kind, { fk: fkCol.get(c.name), list: lists[c.name], table: model.name }), fk: fkCol.get(c.name) };
    return {
      name: c.name,
      type: c.type,
      kind,
      nullable: c.nullable,
      pk: model.primaryKey.includes(c.name),
      unique: uniques.has(c.name),
      autoIncrement: Boolean(c.autoIncrement),
      hasDefault: c.default != null,
      maxLength: maxLength(c.type),
      list: lists[c.name] || null,
      spec,
      samples: spec.gen === 'fk' || spec.gen === 'skip' ? [] : Array.from({ length: 3 }, (_, i) => make(spec, i, {})),
    };
  });
  const count = Number((await db.raw(conn, `SELECT COUNT(*) FROM ${qualified(conn.type, ns, table)}`)).rows[0][0]);
  return { table, rows: count, columns, foreignKeys: model.foreignKeys.map((f) => ({ columns: f.columns, refTable: f.refTable, refColumns: f.refColumns })) };
}

/**
 * opts: { conn, ns, tables: [{ table, rows, mode: 'append'|'replace', columns: { name: spec } }], seed }
 * Tables are processed parents-first so FK columns can reference freshly generated rows.
 */
export async function runGenerate(ctx, opts) {
  const { conn, ns } = opts;
  const ty = conn.type;
  const reqs = opts.tables || [];
  if (!reqs.length) throw new Error(t('Select at least one table'));
  const models = await describeSchema(conn, ns, reqs.map((r) => r.table));
  const byName = new Map(models.map((m) => [m.name, m]));
  const order = [];
  const seen = new Set();
  const visit = (name, stack = new Set()) => {
    if (seen.has(name) || stack.has(name) || !byName.has(name)) return;
    stack.add(name);
    for (const fk of byName.get(name).foreignKeys) if (fk.refTable !== name && reqs.some((r) => r.table === fk.refTable)) visit(fk.refTable, stack);
    seen.add(name);
    order.push(name);
  };
  reqs.forEach((r) => visit(r.table));
  const total = reqs.reduce((s, r) => s + Number(r.rows || 0), 0);
  let done = 0;
  const rand = mulberry32(Number(opts.seed) || Date.now() % 2147483647);
  const make = makeFactory(rand);

  // replace mode: empty children before parents
  for (const name of [...order].reverse()) {
    const r = reqs.find((x) => x.table === name);
    if (r.mode !== 'replace') continue;
    await db.withSession(conn, ns, async (s) => {
      if (ty === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 0');
      try {
        await s.run(`DELETE FROM ${qualified(ty, ns, name)}`);
      } finally {
        if (ty === 'mysql') await s.run('SET FOREIGN_KEY_CHECKS = 1');
      }
    });
    ctx.log(t('{table}: emptied', { table: name }));
  }

  const results = [];
  for (const name of order) {
    ctx.checkCancel();
    const req = reqs.find((x) => x.table === name);
    const model = byName.get(name);
    const lists = await allowedValues(conn, ns, model);
    const nRows = Math.max(0, Math.min(1_000_000, Number(req.rows) || 0));
    const fkCol = new Map();
    for (const fk of model.foreignKeys) fk.columns.forEach((c, i) => fkCol.set(c, { table: fk.refTable, column: fk.refColumns[i] }));
    const specs = [];
    for (const c of model.columns) {
      const kind = lists.__json?.includes(c.name) ? 'json' : canonicalType(c.type, ty).kind;
      const spec = { ...suggest(c, kind, { fk: fkCol.get(c.name), list: lists[c.name], table: model.name }), ...(req.columns?.[c.name] || {}) };
      if (spec.gen === 'skip') continue;
      if (spec.gen === 'fk') {
        const ref = spec.fk || fkCol.get(c.name);
        if (!ref) throw new Error(t('{column}: this column is not a foreign key', { column: `${name}.${c.name}` }));
        const r = await db.raw(conn, `SELECT DISTINCT ${q(ty, ref.column)} FROM ${qualified(ty, ns, ref.table)} LIMIT 50000`);
        spec.keys = r.rows.map((x) => x[0]).filter((v) => v != null);
        if (!spec.keys.length && !c.nullable) throw new Error(t('{column}: parent table "{parent}" is still empty — generate that table first (or select it too).', { column: `${name}.${c.name}`, parent: ref.table }));
      }
      const uniq =
        (model.primaryKey.length === 1 && model.primaryKey[0] === c.name) ||
        model.indexes.some((i) => i.unique && i.columns.length === 1 && i.columns[0] === c.name);
      let existing = null;
      if (uniq && req.mode !== 'replace') {
        const r = await db.raw(conn, `SELECT ${q(ty, c.name)} FROM ${qualified(ty, ns, name)}`);
        existing = new Set(r.rows.map((x) => String(x[0])));
      }
      specs.push({ col: c, kind, spec, maxLen: maxLength(c.type), unique: uniq ? existing || new Set() : null, nullRatio: Number(spec.nullRatio || 0) });
    }
    if (!specs.length) throw new Error(t('{table}: no columns to fill', { table: name }));
    const cols = specs.map((s) => s.col.name);

    // Multi-column PRIMARY KEY / UNIQUE: track value tuples and regenerate the row on collision.
    const composite = [];
    for (const key of [model.primaryKey, ...model.indexes.filter((x) => x.unique && !x.complex).map((x) => x.columns)]) {
      if (!key || key.length < 2) continue;
      const idx = key.map((c) => cols.indexOf(c));
      if (idx.some((k) => k < 0)) continue;
      const seenTuples = new Set();
      if (req.mode !== 'replace') {
        const r = await db.raw(conn, `SELECT ${key.map((c) => q(ty, c)).join(', ')} FROM ${qualified(ty, ns, name)}`);
        r.rows.forEach((row) => seenTuples.add(JSON.stringify(row.map(String))));
      }
      composite.push({ idx, seen: seenTuples, key });
    }

    // One candidate row; single-column unique values are committed only when the row is accepted.
    const makeRow = (i) => {
      const adds = [];
      const row = specs.map((s) => {
        if (s.nullRatio && s.col.nullable && rand() < s.nullRatio) return null;
        let v;
        for (let attempt = 0; attempt < 40; attempt++) {
          v = make(s.spec, i, {});
          if (typeof v === 'string' && s.maxLen) v = v.slice(0, s.maxLen);
          if (s.kind === 'bool') v = ty === 'postgres' ? Boolean(v) : v ? 1 : 0;
          if (!s.unique || v == null || !s.unique.has(String(v))) break;
          if (attempt > 20 && typeof v === 'string') v = (v + '-' + Math.floor(rand() * 1e6)).slice(-(s.maxLen || 255));
          if (attempt > 20 && typeof v === 'number') v = v + Math.floor(rand() * 1e9);
        }
        if (s.unique && v != null) {
          if (s.unique.has(String(v))) throw new Error(t('{column}: cannot generate more unique values (the range is too narrow)', { column: `${name}.${s.col.name}` }));
          adds.push([s.unique, String(v)]);
        }
        return v;
      });
      return { row, adds };
    };

    let inserted = 0;
    const B = 500;
    for (let start = 0; start < nRows; start += B) {
      ctx.checkCancel();
      const rows = [];
      for (let i = start; i < Math.min(nRows, start + B); i++) {
        for (let attempt = 0; ; attempt++) {
          const { row, adds } = makeRow(i);
          const tuples = composite.map((c) => JSON.stringify(c.idx.map((k) => String(row[k]))));
          if (composite.every((c, k) => !c.seen.has(tuples[k]))) {
            composite.forEach((c, k) => c.seen.add(tuples[k]));
            adds.forEach(([set, v]) => set.add(v));
            rows.push(row);
            break;
          }
          if (attempt > 60) {
            throw new Error(t('{table}: unique combinations ({keys}) exhausted — reduce the row count or add more parent data.', { table: name, keys: composite.map((c) => c.key.join(' + ')).join(', ') }));
          }
        }
      }
      await db.transaction(conn, ns, (s) => db.insertRows(s, ty, ns, name, cols, rows));
      inserted += rows.length;
      done += rows.length;
      ctx.item(name, { table: name, rows: nRows, done: inserted, state: inserted >= nRows ? 'done' : 'filling', status: inserted >= nRows ? t('done') : t('filling') });
      ctx.progress(total ? done / total : 1, `${name} — ${num(inserted)} / ${num(nRows)}`);
    }
    if (ty === 'postgres') {
      for (const c of model.columns.filter((x) => x.autoIncrement)) {
        const T = qualified(ty, ns, name);
        await db.raw(conn, `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE(MAX(${q(ty, c.name)}), 1), 1)) FROM ${T}`, [T, c.name]).catch(() => {});
      }
    }
    results.push({ table: name, inserted });
    ctx.log(t('{table}: {rows} created', { table: name, rows: plural(inserted, '{n} row', '{n} rows') }));
  }
  return { tables: results, rows: done };
}

export function sampleValues(spec, n = 5) {
  const make = makeFactory(mulberry32(Date.now() % 100000));
  return Array.from({ length: n }, (_, i) => make(spec, i, {}));
}
