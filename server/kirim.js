#!/usr/bin/env node
/*
 * Layanan "Kirim soal": menerima file RTF dari aplikasi Konver Soal lalu mengirimnya
 * lewat email (SMTP, mis. Gmail dengan App Password) ke alamat tujuan yang dikunci di server.
 * Tanpa pustaka tambahan (hanya modul bawaan Node.js >= 14).
 *
 * Konfigurasi lewat variabel lingkungan (biasanya /etc/konver-soal/kirim.env):
 *   SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   SMTP_SECURE=true
 *   SMTP_USER=pengirim@gmail.com   SMTP_PASS=<app password 16 huruf>
 *   MAIL_TO=terimasoal@sman2makassar.sch.id   MAIL_FROM_NAME=Konver Soal
 *   PORT=3091   HOST=127.0.0.1   RATE_PER_HOUR=20
 *   ADMIN_PASS=<kata sandi admin untuk mengunci semester & tahun ajaran>
 *
 * Endpoint:  GET/POST /api/pengaturan  (semester & tahun ajaran yang dikunci admin)
 *   POST { sandi, kunci, semester, tahunAjaran }  atau  { sandi, cekSandi: true }
 *
 * Endpoint:  POST /api/kirim  (JSON)
 *   { nama, mapel, kelas, fileName, rtf (teks) | rtfBase64, jumlahSoal, perluDicek, namaFileAsli }
 *   Body boleh dikompres (Content-Encoding: gzip).
 */
'use strict';

const http = require('http');
const net = require('net');
const tls = require('tls');
const os = require('os');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: !/^(0|false|no)$/i.test(process.env.SMTP_SECURE || 'true'),
  // Buang spasi/karakter tak terlihat (mis. ikut tertempel) dan tanda kutip di tepi.
  user: (process.env.SMTP_USER || '').replace(/[\s​-‍﻿]+/g, '').replace(/^["']|["']$/g, ''),
  pass: (process.env.SMTP_PASS || '').replace(/[\s​-‍﻿]+/g, '').replace(/^["']|["']$/g, ''),
  to: process.env.MAIL_TO || 'terimasoal@sman2makassar.sch.id',
  fromName: process.env.MAIL_FROM_NAME || 'Konver Soal',
  listenPort: parseInt(process.env.PORT || '3091', 10),
  listenHost: process.env.HOST || '127.0.0.1',
  ratePerHour: parseInt(process.env.RATE_PER_HOUR || '20', 10),
  maxBytes: 20 * 1024 * 1024, // RTF maks ±20 MB (batas lampiran Gmail 25 MB)
  adminPass: (process.env.ADMIN_PASS || '').trim(),
  // systemd StateDirectory= mengisi STATE_DIRECTORY (mis. /var/lib/konver-soal)
  stateDir: process.env.STATE_DIRECTORY || process.env.STATE_DIR || path.join(__dirname, 'data'),
};

// ---------- Pengaturan yang dikunci admin (semester & tahun ajaran) ----------
const RE_SEMESTER = /^(Ganjil|Genap)$/;
const RE_TA = /^(\d{4})\/(\d{4})$/;
const settingsFile = () => path.join(cfg.stateDir, 'pengaturan.json');

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const ok = !!s.kunci && RE_SEMESTER.test(s.semester) && RE_TA.test(s.tahunAjaran);
    return ok ? { kunci: true, semester: s.semester, tahunAjaran: s.tahunAjaran, diubah: s.diubah || null } : { kunci: false };
  } catch (e) {
    return { kunci: false };
  }
}

function writeSettings(s) {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const tmp = settingsFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, settingsFile());
}

const sandiCocok = s => {
  const a = Buffer.from(String(s || '')), b = Buffer.from(cfg.adminPass);
  return cfg.adminPass.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- SMTP (minimal: TLS langsung / STARTTLS, AUTH LOGIN) ----------
function smtpSend({ from, to, data }) {
  return new Promise((resolve, reject) => {
    let sock = cfg.secure
      ? tls.connect(cfg.port, cfg.host, { servername: cfg.host })
      : net.connect(cfg.port, cfg.host);
    let buf = '';
    let waiter = null;
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 60000);
    const fail = err => { clearTimeout(timer); try { sock.destroy(); } catch (e) { /* abaikan */ } reject(err); };

    const onData = chunk => {
      buf += chunk.toString('utf8');
      // Respons lengkap: baris terakhir "NNN spasi ..."
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const resp = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          if (waiter) { const w = waiter; waiter = null; w(resp); }
          return;
        }
      }
    };
    const attach = s => { s.on('data', onData); s.on('error', fail); };
    attach(sock);

    const expect = (code) => new Promise((res, rej) => {
      waiter = resp => (resp.startsWith(String(code)) ? res(resp) : rej(new Error('SMTP: ' + resp.split('\n').pop())));
    });
    const cmd = (line, code) => { const p = expect(code); sock.write(line + '\r\n'); return p; };

    (async () => {
      await expect(220);
      const me = os.hostname() || 'localhost';
      let ehlo = await cmd('EHLO ' + me, 250);
      if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
        await cmd('STARTTLS', 220);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: cfg.host });
        attach(sock);
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        ehlo = await cmd('EHLO ' + me, 250);
      }
      if (cfg.user) {
        await cmd('AUTH LOGIN', 334);
        await cmd(Buffer.from(cfg.user).toString('base64'), 334);
        await cmd(Buffer.from(cfg.pass).toString('base64'), 235);
      }
      await cmd('MAIL FROM:<' + from + '>', 250);
      await cmd('RCPT TO:<' + to + '>', 250);
      await cmd('DATA', 354);
      // Titik di awal baris digandakan (dot-stuffing)
      await cmd(data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.', 250);
      await cmd('QUIT', 221).catch(() => {});
      clearTimeout(timer);
      sock.end();
      resolve();
    })().catch(fail);
  });
}

// ---------- Pesan MIME ----------
const encWord = s => '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
const wrap76 = s => s.replace(/(.{76})/g, '$1\r\n');
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildMessage({ nama, mapel, kelas, semester, tahunAjaran, fileName, rtf, jumlahSoal, perluDicek, namaFileAsli }) {
  const boundary = 'ks-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const altBoundary = boundary + '-alt';
  const subject = 'Soal ' + mapel + ' - Kelas ' + kelas +
    (semester ? ' - Semester ' + semester : '') + (tahunAjaran ? ' ' + tahunAjaran : '') + ' - ' + nama;
  // Singkat: "24/10/2026 14.34" (tanpa detik).
  const waktu = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
  const rows = [
    ['Nama guru', nama],
    ['Mata pelajaran', mapel],
    ['Kelas', kelas],
    ['Semester', semester || '-'],
    ['Tahun ajaran', tahunAjaran || '-'],
    ['Jumlah soal', jumlahSoal != null ? jumlahSoal : '-'],
    ['Perlu dicek', perluDicek != null ? perluDicek : '-'],
    ['File asli', namaFileAsli || '-'],
    ['Waktu kirim', waktu + ' WITA'],
  ];
  // Teks biasa: sejajar bila dibaca dengan huruf monospace.
  const width = Math.max(...rows.map(r => r[0].length));
  const text = ['Kiriman soal dari aplikasi Konver Soal.', '']
    .concat(rows.map(([k, v]) => k.padEnd(width) + ' : ' + v), ['', 'File RTF terlampir.'])
    .join('\r\n');
  // HTML: tabel, sehingga titik dua tetap sejajar di Gmail/Outlook (huruf proporsional).
  const td = 'padding:3px 0;vertical-align:top;';
  const html = '<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1b2430">' +
    '<p style="margin:0 0 12px">Kiriman soal dari aplikasi Konver Soal.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
    rows.map(([k, v]) => '<tr><td style="' + td + 'white-space:nowrap;color:#5a6576">' + escHtml(k) + '</td>' +
      '<td style="' + td + 'padding:3px 8px;">:</td><td style="' + td + 'font-weight:bold">' + escHtml(v) + '</td></tr>').join('') +
    '</table><p style="margin:12px 0 0">File RTF terlampir.</p></body></html>';
  return [
    'From: ' + encWord(cfg.fromName) + ' <' + cfg.user + '>',
    'To: <' + cfg.to + '>',
    'Subject: ' + encWord(subject),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: multipart/alternative; boundary="' + altBoundary + '"',
    '',
    '--' + altBoundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
    '--' + altBoundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(html, 'utf8').toString('base64')),
    '--' + altBoundary + '--',
    '--' + boundary,
    'Content-Type: application/rtf; name="' + fileName + '"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="' + fileName + '"',
    '',
    wrap76(rtf.toString('base64')),
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

// ---------- HTTP ----------
const hits = new Map(); // ip -> [waktu kirim]
function rateOk(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= cfg.ratePerHour) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  return true;
}

const clean = (s, max) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const safeName = s => clean(s, 120).replace(/[^\w .()\-]+/g, '_') || 'soal.rtf';

function reply(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Salah sandi admin: maks 5 kali per 15 menit per IP.
const gagalAdmin = new Map();
function adminDiblokir(ip) {
  const now = Date.now();
  const list = (gagalAdmin.get(ip) || []).filter(t => now - t < 15 * 60e3);
  gagalAdmin.set(ip, list);
  return list.length >= 5;
}

function pengaturan(req, res, ip) {
  if (req.method === 'GET') return reply(res, 200, Object.assign({ ok: true, adminAktif: !!cfg.adminPass }, readSettings()));
  if (req.method !== 'POST') return reply(res, 405, { ok: false, pesan: 'Metode tidak didukung' });
  if (!cfg.adminPass) return reply(res, 503, { ok: false, pesan: 'Kata sandi admin belum diatur di server (sudo bash deploy/install.sh --update --admin).' });
  if (adminDiblokir(ip)) return reply(res, 429, { ok: false, pesan: 'Terlalu banyak percobaan sandi. Coba lagi 15 menit lagi.' });
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size > 4096) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    let b;
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reply(res, 400, { ok: false, pesan: 'Data tidak valid.' }); }
    if (!sandiCocok(b.sandi)) {
      gagalAdmin.get(ip).push(Date.now());
      log('sandi admin salah', ip);
      return reply(res, 403, { ok: false, pesan: 'Kata sandi admin salah.' });
    }
    if (b.cekSandi) return reply(res, 200, Object.assign({ ok: true }, readSettings()));
    const kunci = !!b.kunci;
    if (kunci && (!RE_SEMESTER.test(b.semester) || !RE_TA.test(b.tahunAjaran || ''))) {
      return reply(res, 400, { ok: false, pesan: 'Pilih semester dan tahun ajaran.' });
    }
    const s = kunci
      ? { kunci: true, semester: b.semester, tahunAjaran: b.tahunAjaran, diubah: new Date().toISOString() }
      : { kunci: false, diubah: new Date().toISOString() };
    try { writeSettings(s); } catch (e) {
      log('gagal simpan pengaturan', e.message);
      return reply(res, 500, { ok: false, pesan: 'Gagal menyimpan pengaturan di server.' });
    }
    log('pengaturan diubah', ip, JSON.stringify(s));
    reply(res, 200, Object.assign({ ok: true }, readSettings()));
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/kirim/status') {
    return reply(res, 200, { ok: true, siap: !!(cfg.user && cfg.pass), tujuan: cfg.to });
  }
  if (req.url === '/api/pengaturan') {
    return pengaturan(req, res, (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString());
  }
  if (req.method !== 'POST' || req.url !== '/api/kirim') return reply(res, 404, { ok: false, pesan: 'Tidak ditemukan' });
  if (!cfg.user || !cfg.pass) return reply(res, 503, { ok: false, pesan: 'Pengiriman email belum diatur di server (SMTP_USER/SMTP_PASS).' });

  const ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString();
  if (!rateOk(ip)) return reply(res, 429, { ok: false, pesan: 'Terlalu banyak kiriman. Coba lagi nanti.' });

  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > cfg.maxBytes * 1.4) { reply(res, 413, { ok: false, pesan: 'File terlalu besar.' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let body;
    try {
      let raw = Buffer.concat(chunks);
      // Aplikasi mengompres body dengan gzip (±10x lebih kecil, unggah jauh lebih cepat).
      if (/gzip/i.test(req.headers['content-encoding'] || '')) {
        raw = await new Promise((ok, no) => zlib.gunzip(raw, { maxOutputLength: cfg.maxBytes * 2 }, (e, out) => (e ? no(e) : ok(out))));
        if (raw.length > cfg.maxBytes * 2) return reply(res, 413, { ok: false, pesan: 'File terlalu besar.' });
      }
      body = JSON.parse(raw.toString('utf8'));
    } catch (e) { return reply(res, 400, { ok: false, pesan: 'Data tidak valid.' }); }
    const nama = clean(body.nama, 80), mapel = clean(body.mapel, 80), kelas = clean(body.kelas, 40);
    if (!nama || !mapel || !kelas) return reply(res, 400, { ok: false, pesan: 'Nama guru, mata pelajaran, dan kelas wajib diisi.' });
    // RTF dikirim sebagai teks (rtf) atau, dari versi lama aplikasi, base64 (rtfBase64).
    const rtf = typeof body.rtf === 'string'
      ? Buffer.from(body.rtf, 'latin1')
      : Buffer.from(String(body.rtfBase64 || ''), 'base64');
    if (rtf.length < 10 || rtf.length > cfg.maxBytes || !rtf.slice(0, 6).toString('latin1').startsWith('{\\rtf')) {
      return reply(res, 400, { ok: false, pesan: 'Lampiran bukan file RTF yang valid.' });
    }
    let fileName = safeName(body.fileName);
    let semester = RE_SEMESTER.test(body.semester) ? body.semester : '';
    let tahunAjaran = RE_TA.test(body.tahunAjaran || '') ? body.tahunAjaran : '';
    // Semester & tahun ajaran yang dikunci admin selalu menang (juga untuk aplikasi versi lama di browser).
    const lock = readSettings();
    if (lock.kunci && (semester !== lock.semester || tahunAjaran !== lock.tahunAjaran)) {
      semester = lock.semester;
      tahunAjaran = lock.tahunAjaran;
      fileName = safeName([mapel, kelas, semester, tahunAjaran.replace('/', '-')].join('-'));
    }
    if (!/\.rtf$/i.test(fileName)) fileName += '.rtf';
    try {
      const data = buildMessage({
        nama, mapel, kelas, fileName, rtf, semester, tahunAjaran,
        jumlahSoal: Number.isFinite(body.jumlahSoal) ? body.jumlahSoal : null,
        perluDicek: Number.isFinite(body.perluDicek) ? body.perluDicek : null,
        namaFileAsli: clean(body.namaFileAsli, 160),
      });
      await smtpSend({ from: cfg.user, to: cfg.to, data });
      log('terkirim', ip, mapel, kelas, nama, fileName, rtf.length + ' B');
      reply(res, 200, { ok: true, pesan: 'Soal terkirim ke ' + cfg.to });
    } catch (e) {
      log('gagal', ip, e.message);
      reply(res, 502, { ok: false, pesan: 'Gagal mengirim email: ' + e.message });
    }
  });
});

// ---------- Mode cek: node kirim.js --cek  (uji login SMTP tanpa mengirim email) ----------
if (process.argv.includes('--cek')) {
  const show = s => (s ? s.length + ' karakter' : '(kosong)');
  console.log('Server SMTP   : ' + cfg.host + ':' + cfg.port + (cfg.secure ? ' (TLS)' : ''));
  console.log('Pengirim      : "' + cfg.user + '"');
  console.log('Sandi         : ' + show(cfg.pass) + (cfg.pass && !/^[a-z]{16}$/.test(cfg.pass)
    ? '  <- App Password Google biasanya tepat 16 huruf kecil a-z' : (cfg.pass ? '  (format App Password OK)' : '')));
  console.log('Penerima      : ' + cfg.to);
  const sock = tls.connect(cfg.port, cfg.host, { servername: cfg.host });
  let buf = '', step = 0;
  const send = l => sock.write(l + '\r\n');
  sock.on('data', d => {
    buf += d.toString();
    if (!/\r\n$/.test(buf) || !/^\d{3} /m.test(buf.split('\r\n').slice(-2)[0] || '')) return;
    const resp = buf.trim(); buf = '';
    const code = resp.split('\n').pop().slice(0, 3);
    if (step === 0) { step = 1; send('EHLO cek'); }
    else if (step === 1) { step = 2; send('AUTH LOGIN'); }
    else if (step === 2) { step = 3; send(Buffer.from(cfg.user).toString('base64')); }
    else if (step === 3) { step = 4; send(Buffer.from(cfg.pass).toString('base64')); }
    else if (step === 4) {
      console.log(code === '235' ? '\nHASIL: LOGIN BERHASIL - tombol Kirim siap dipakai.'
        : '\nHASIL: LOGIN DITOLAK Google: ' + resp.split('\n').pop() +
          '\n  -> Pastikan memakai App Password (bukan sandi akun) yang dibuat SETELAH sandi akun terakhir diganti,' +
          '\n     Verifikasi 2 Langkah aktif, dan alamat pengirim benar.');
      send('QUIT'); sock.end(); process.exitCode = code === '235' ? 0 : 1;
    }
  });
  sock.on('error', e => { console.log('\nHASIL: tidak bisa terhubung ke ' + cfg.host + ': ' + e.message); process.exitCode = 1; });
  return;
}

server.listen(cfg.listenPort, cfg.listenHost, () => {
  log('Layanan kirim soal aktif di http://' + cfg.listenHost + ':' + cfg.listenPort + ' -> ' + cfg.to +
    (cfg.user ? '' : ' (SMTP belum diatur)'));
});
