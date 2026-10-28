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

/* ---------- auto backup ke Google Drive ---------- */
// Aktif bila GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, dan GDRIVE_REFRESH_TOKEN diisi (lihat scripts/gdrive-auth.js).
// Memakai scope drive.file: aplikasi hanya bisa melihat file/folder yang dibuatnya sendiri.
const GDRIVE = {
  clientId: process.env.GDRIVE_CLIENT_ID || '',
  clientSecret: process.env.GDRIVE_CLIENT_SECRET || '',
  refreshToken: process.env.GDRIVE_REFRESH_TOKEN || '',
  folderName: process.env.GDRIVE_FOLDER_NAME || 'Inventaris Elektronik Backup',
  hours: Math.max(1, Number(process.env.GDRIVE_BACKUP_HOURS) || 24),
  keep: Math.max(1, Number(process.env.GDRIVE_KEEP) || 30),
};
GDRIVE.enabled = Boolean(GDRIVE.clientId && GDRIVE.clientSecret && GDRIVE.refreshToken);

const readInternal = (key) => { try { return JSON.parse(q.getSetting.get(key)?.value || 'null'); } catch { return null; } };
const writeInternal = (key, value) => q.putSetting.run(key, JSON.stringify(value));

let driveToken = null; // { value, expires }
async function driveAccessToken() {
  if (driveToken && driveToken.expires > Date.now() + 60_000) return driveToken.value;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GDRIVE.clientId, client_secret: GDRIVE.clientSecret,
      refresh_token: GDRIVE.refreshToken, grant_type: 'refresh_token',
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Login Google gagal: ${data.error_description || data.error || r.status}`);
  driveToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return driveToken.value;
}

async function driveApi(pathAndQuery, { method = 'GET', body, headers = {}, upload = false } = {}) {
  const base = upload ? 'https://www.googleapis.com/upload/drive/v3' : 'https://www.googleapis.com/drive/v3';
  const r = await fetch(base + pathAndQuery, {
    method, body,
    headers: { Authorization: `Bearer ${await driveAccessToken()}`, ...headers },
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Drive: ${data.error?.message || r.status}`);
  return data;
}

async function driveFolder() {
  const saved = readInternal('_gdrive_folder');
  if (saved) {
    // pastikan folder belum dihapus pengguna
    const f = await driveApi(`/files/${encodeURIComponent(saved)}?fields=id,trashed`).catch(() => null);
    if (f && !f.trashed) return saved;
  }
  // folder yang pernah dibuat aplikasi ini (mis. dari server/database lain) dipakai ulang agar tidak dobel
  const query = encodeURIComponent(`name = '${GDRIVE.folderName.replace(/['\\]/g, '\\$&')}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await driveApi(`/files?q=${query}&orderBy=createdTime&pageSize=1&fields=files(id)`);
  if (found.files?.[0]) {
    writeInternal('_gdrive_folder', found.files[0].id);
    return found.files[0].id;
  }
  const created = await driveApi('/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: GDRIVE.folderName, mimeType: 'application/vnd.google-apps.folder' }),
  });
  writeInternal('_gdrive_folder', created.id);
  return created.id;
}

// Hanya menyimpan GDRIVE_KEEP file terbaru; sisanya dipindah ke Sampah Drive (masih bisa dipulihkan 30 hari).
async function drivePrune(folder) {
  const query = encodeURIComponent(`'${folder}' in parents and trashed = false and name contains 'Backup-Inventaris_'`);
  const list = await driveApi(`/files?q=${query}&orderBy=createdTime desc&pageSize=1000&fields=files(id)`);
  for (const f of (list.files || []).slice(GDRIVE.keep)) {
    await driveApi(`/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  }
}

let driveRunning = null;
// force=false: lewati bila data belum berubah sejak backup terakhir.
function driveBackup(force = false) {
  if (!GDRIVE.enabled) return Promise.reject(Object.assign(new Error('Auto backup Google Drive belum dikonfigurasi'), { status: 400 }));
  if (driveRunning) return driveRunning;
  driveRunning = (async () => {
    const prev = readInternal('_gdrive_last') || {};
    const rev = getRev();
    const attemptAt = new Date().toISOString();
    if (!force && prev.ok && prev.rev === rev) {
      writeInternal('_gdrive_last', { ...prev, checkedAt: attemptAt });
      return { skipped: true };
    }
    try {
      const folder = await driveFolder();
      // akun pemilik Drive, ditampilkan di Pengaturan supaya jelas backup masuk ke mana
      const about = await driveApi('/about?fields=user(emailAddress)').catch(() => null);
      const state = readState();
      // format sama dengan "Backup lengkap (.json)" di aplikasi, jadi bisa dipulihkan dari menu Pengaturan
      const payload = JSON.stringify({ app: 'inventaris-elektronik', version: 1, exportedAt: attemptAt, source: 'gdrive-auto', ...state }, null, 2);
      const name = `Backup-Inventaris_${attemptAt.slice(0, 19).replace('T', '_').replace(/:/g, '-')}.json`;
      const boundary = 'inv' + crypto.randomBytes(12).toString('hex');
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder], mimeType: 'application/json' })}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`), Buffer.from(payload), Buffer.from(`\r\n--${boundary}--`),
      ]);
      const file = await driveApi('/files?uploadType=multipart&fields=id,name,size,webViewLink', {
        method: 'POST', upload: true, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      });
      await drivePrune(folder).catch((err) => console.error('Gagal merapikan backup lama di Drive:', err.message));
      const last = { ok: true, account: about?.user?.emailAddress || prev.account || null, at: attemptAt, checkedAt: attemptAt, rev, name: file.name, size: Number(file.size) || payload.length, link: file.webViewLink, folder, items: state.items.length };
      writeInternal('_gdrive_last', last);
      console.log(`Backup Google Drive: ${file.name}`);
      return last;
    } catch (err) {
      writeInternal('_gdrive_last', { ...prev, ok: false, checkedAt: attemptAt, error: err.message });
      console.error('Backup Google Drive gagal:', err.message);
      throw Object.assign(err, { status: 502 });
    }
  })().finally(() => { driveRunning = null; });
  return driveRunning;
}

function driveStatus() {
  const last = readInternal('_gdrive_last');
  const folder = readInternal('_gdrive_folder');
  return {
    enabled: GDRIVE.enabled, intervalHours: GDRIVE.hours, keep: GDRIVE.keep, account: last?.account || null,
    lastSuccess: last?.at || null, lastFile: last?.name || null, lastLink: last?.link || null,
    lastCheck: last?.checkedAt || null, error: last && !last.ok ? last.error : null,
    folderUrl: folder ? `https://drive.google.com/drive/folders/${folder}` : null,
    running: Boolean(driveRunning),
  };
}

// Dicek tiap 15 menit; backup berjalan bila sudah lewat GDRIVE_BACKUP_HOURS sejak backup sukses terakhir.
// Setelah gagal, dicoba lagi paling cepat 1 jam kemudian.
function driveTick() {
  const last = readInternal('_gdrive_last') || {};
  const since = (iso) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);
  const due = since(last.at) >= GDRIVE.hours * 3600_000 && (last.ok !== false || since(last.checkedAt) >= 3600_000);
  if (due) driveBackup().catch(() => {});
}
if (GDRIVE.enabled) {
  setTimeout(driveTick, 30_000).unref();
  setInterval(driveTick, 15 * 60_000).unref();
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
    if (route === 'GET /api/gdrive') return send(res, 200, driveStatus());
    if (route === 'POST /api/gdrive/backup') {
      await driveBackup(true);
      return send(res, 200, driveStatus());
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
  console.log(GDRIVE.enabled ? `Auto backup Google Drive aktif (tiap ${GDRIVE.hours} jam, simpan ${GDRIVE.keep} file)` : 'Auto backup Google Drive nonaktif (isi GDRIVE_* untuk mengaktifkan)');
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
