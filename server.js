// Server Inventaris Elektronik
// Menyajikan public/index.html dan API sinkronisasi data yang disimpan di SQLite.
// Tanpa dependensi eksternal: butuh Node.js >= 22.13 (modul bawaan node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 25 * 1024 * 1024;
const SETTING_KEYS = ['categories', 'locations', 'projects', 'meta'];
const INDEX_FILE = path.join(ROOT, 'public', 'index.html');

/* ---------- database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'inventaris.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS logs_date ON logs (date);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const q = {
  items: db.prepare('SELECT data FROM items ORDER BY rowid'),
  logs: db.prepare('SELECT data FROM logs ORDER BY date DESC, rowid DESC'),
  settings: db.prepare('SELECT key, value FROM settings'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  putItem: db.prepare('INSERT INTO items (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
  delItem: db.prepare('DELETE FROM items WHERE id = ?'),
  putLog: db.prepare('INSERT INTO logs (id, date, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, data = excluded.data'),
  delLog: db.prepare('DELETE FROM logs WHERE id = ?'),
};

const getRev = () => Number(q.getSetting.get('_rev')?.value || 0);

function readState() {
  const state = {
    rev: getRev(),
    items: q.items.all().map((r) => JSON.parse(r.data)),
    logs: q.logs.all().map((r) => JSON.parse(r.data)),
  };
  for (const { key, value } of q.settings.all()) {
    if (SETTING_KEYS.includes(key)) state[key] = JSON.parse(value);
  }
  return state;
}

const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64;
const validRecords = (list) => Array.isArray(list) && list.every((x) => x && typeof x === 'object' && validId(x.id));
const validIds = (list) => Array.isArray(list) && list.every(validId);

// Menerapkan perubahan dari satu klien dalam satu transaksi, lalu menaikkan nomor revisi.
function applySync(body) {
  const items = body.items || {}, logs = body.logs || {}, settings = body.settings || {};
  const parts = [items.upsert || [], logs.upsert || []];
  if (!parts.every(validRecords) || !validIds(items.remove || []) || !validIds(logs.remove || [])) {
    throw Object.assign(new Error('Format data tidak valid'), { status: 400 });
  }
  const prevRev = getRev();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items.upsert || []) q.putItem.run(it.id, JSON.stringify(it));
    for (const id of items.remove || []) q.delItem.run(id);
    for (const l of logs.upsert || []) q.putLog.run(l.id, String(l.date || ''), JSON.stringify(l));
    for (const id of logs.remove || []) q.delLog.run(id);
    for (const key of SETTING_KEYS) {
      if (key in settings) q.putSetting.run(key, JSON.stringify(settings[key]));
    }
    q.putSetting.run('_rev', String(prevRev + 1));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { rev: prevRev + 1, stale: Number(body.baseRev) !== prevRev };
}

/* ---------- http ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const EXPECTED_AUTH = APP_PASSWORD ? sha(`${APP_USER}:${APP_PASSWORD}`) : null;

function authorized(req) {
  if (!EXPECTED_AUTH) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  return crypto.timingSafeEqual(sha(Buffer.from(m[1], 'base64').toString('utf8')), EXPECTED_AUTH);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Data terlalu besar'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('JSON tidak valid'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /healthz') return send(res, 200, { ok: true });

    if (!authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Inventaris Elektronik", charset="UTF-8"');
      return send(res, 401, { error: 'Perlu login' });
    }

    if (route === 'GET /' || route === 'GET /index.html') {
      return send(res, 200, fs.readFileSync(INDEX_FILE), 'text/html; charset=utf-8');
    }
    if (route === 'GET /api/rev') return send(res, 200, { rev: getRev() });
    if (route === 'GET /api/state') return send(res, 200, readState());
    if (route === 'POST /api/sync') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { error: 'Content-Type harus application/json' });
      }
      return send(res, 200, applySync(await readJson(req)));
    }
    send(res, 404, { error: 'Tidak ditemukan' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Inventaris Elektronik berjalan di http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data: ${path.join(DATA_DIR, 'inventaris.db')}`);
  console.log(APP_PASSWORD ? `Login aktif (user: ${APP_USER})` : 'PERINGATAN: APP_PASSWORD kosong, siapa pun yang bisa membuka alamat ini dapat mengubah data.');
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
