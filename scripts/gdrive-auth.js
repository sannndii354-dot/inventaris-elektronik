// Membuat GDRIVE_REFRESH_TOKEN untuk auto backup Google Drive.
// Jalankan SEKALI di komputer yang punya browser (tidak harus di server):
//   node scripts/gdrive-auth.js CLIENT_ID CLIENT_SECRET [EMAIL_AKUN_TUJUAN]
// atau isi GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET di environment lalu: node scripts/gdrive-auth.js
// Client OAuth harus bertipe "Desktop app" di Google Cloud Console.
import http from 'node:http';
import crypto from 'node:crypto';

const clientId = process.argv[2] || process.env.GDRIVE_CLIENT_ID;
const clientSecret = process.argv[3] || process.env.GDRIVE_CLIENT_SECRET;
// akun Google tujuan backup; dipilihkan otomatis di halaman login
const account = process.argv[4] || process.env.GDRIVE_ACCOUNT || '';
if (!clientId || !clientSecret) {
  console.error('Pemakaian: node scripts/gdrive-auth.js CLIENT_ID CLIENT_SECRET [EMAIL_AKUN_TUJUAN]');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const stateParam = crypto.randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  const finish = (status, msg) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">${msg}</body>`);
  };
  if (url.searchParams.get('state') !== stateParam) return finish(400, 'Permintaan tidak valid.');
  if (url.searchParams.get('error')) {
    finish(400, `Izin ditolak: ${url.searchParams.get('error')}. Tutup tab ini dan coba lagi.`);
    console.error('Izin ditolak:', url.searchParams.get('error'));
    return server.close();
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code'), client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.refresh_token) throw new Error(data.error_description || data.error || 'refresh_token tidak diterima');
    finish(200, 'Berhasil. Kembali ke terminal untuk menyalin token, lalu tutup tab ini.');
    console.log('\nBerhasil! Tambahkan baris berikut ke file .env di server:\n');
    console.log(`GDRIVE_CLIENT_ID=${clientId}`);
    console.log(`GDRIVE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GDRIVE_REFRESH_TOKEN=${data.refresh_token}\n`);
  } catch (err) {
    finish(500, `Gagal: ${err.message}`);
    console.error('Gagal menukar kode:', err.message);
  }
  server.close();
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state: stateParam,
    code_challenge: challenge, code_challenge_method: 'S256',
    ...(account && { login_hint: account }),
  });
  console.log(`Buka alamat ini di browser, login dengan akun Google ${account || 'tujuan backup'}, lalu izinkan akses:\n`);
  console.log(auth.toString() + '\n');
  console.log('Menunggu izin...');
});
